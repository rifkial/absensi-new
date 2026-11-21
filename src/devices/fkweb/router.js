'use strict';

const express = require('express');
const config = require('../../config');
const {
  registerDevice,
  mapRealtimeLog,
  maybeFixTime,
  queue,
  liveDevices,
} = require('./adapter');
const { decodeBody } = require('./codec');
const { persistLogs } = require('../zkteco4370/adapter');

/** Blok multi-request per `${devId}:${transId}`. */
const blockBuffers = new Map();

function collectBlock(devId, transId, blkNo, raw) {
  const key = `${devId}:${transId}`;
  if (!Number(blkNo)) {
    // blk_no = 0 -> blok tunggal / terakhir.
    if (blockBuffers.has(key) && blockBuffers.get(key).size > 0) {
      const map = blockBuffers.get(key);
      map.set(0, raw);
      const merged = mergeBlocks(map);
      blockBuffers.delete(key);
      return merged;
    }
    return raw;
  }

  if (!blockBuffers.has(key)) blockBuffers.set(key, new Map());
  blockBuffers.get(key).set(Number(blkNo), raw);
  return null;
}

function mergeBlocks(map) {
  const keys = [...map.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  return Buffer.concat(keys.map((k) => map.get(k) || Buffer.alloc(0)));
}

function createFkwebRouter() {
  const router = express.Router();

  // Body mentah supaya bisa decode format FkWeb + merge blok.
  router.use(express.raw({ type: '*/*', limit: config.server.bodyLimit }));

  router.get('/status', async (req, res) => {
    const devices = await require('../../db/pool').queryAll(
      `SELECT id, name, serial_number, ip_address, last_sync_at, last_sync_status
         FROM devices
        WHERE protocol = 'fkweb-http'
        ORDER BY name`
    );
    res.json({
      ok: true,
      port: config.server.fkwebPort,
      live: [...liveDevices.entries()].map(([devId, info]) => ({ devId, ...info })),
      queue: queue.stats(),
      devices,
    });
  });

  router.post('/', async (req, res) => {
    const request_code = String(req.headers.request_code || '').trim().toLowerCase();
    const devId = String(req.headers.dev_id || '').trim();
    const transId = String(req.headers.trans_id || '').trim();
    const cmdReturnCode = String(req.headers.cmd_return_code || '').trim();
    const blkNo = req.headers.blk_no !== undefined ? Number(req.headers.blk_no) : 0;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

    if (!devId || !transId) {
      return res.status(400).end();
    }

    let live;
    try {
      const { json } = decodeBody(raw);
      let fkInfo = null;
      try { fkInfo = json ? JSON.parse(json) : null; } catch { fkInfo = null; }
      live = await registerDevice(devId, req, fkInfo);
    } catch (err) {
      console.error('[fkweb] Gagal registrasi perangkat:', err.message);
      return sendFk(res, 'ERROR', transId, null, Buffer.alloc(0), 500);
    }

    try {
      switch (request_code) {
        case 'receive_cmd': {
          let json = '';
          try { json = decodeBody(raw).json; } catch { json = ''; }
          let fkInfo = null;
          try { fkInfo = json ? JSON.parse(json) : null; } catch { fkInfo = null; }

          maybeFixTime(devId, live, fkInfo?.fk_time);

          const entry = queue.next(devId);
          if (!entry) {
            return sendFk(res, 'ERROR_NO_CMD', transId, null, Buffer.alloc(0));
          }

          return sendFk(res, 'OK', entry.transId, entry.code, entry.param);
        }

        case 'send_cmd_result': {
          const merged = collectBlock(devId, transId, blkNo, raw);
          if (!merged) {
            // Blok lanjutan: ack saja.
            return sendFk(res, 'OK', transId, null, Buffer.alloc(0));
          }

          const { json, bins } = decodeBody(merged);
          let result = {};
          try { result = json ? JSON.parse(json) : {}; } catch { result = { raw: json }; }

          queue.complete(devId, transId, {
            returnCode: cmdReturnCode || 'OK',
            json: result,
            bins,
            raw: merged,
          });

          return sendFk(res, 'OK', transId, null, Buffer.alloc(0));
        }

        case 'realtime_glog': {
          const { json } = decodeBody(raw);
          let data = null;
          try { data = json ? JSON.parse(json) : null; } catch { data = null; }

          const log = mapRealtimeLog(data);
          if (!log) {
            return sendFk(res, 'OK', transId, null, Buffer.alloc(0));
          }

          try {
            await persistLogs({ deviceId: live.deviceId, logs: [log], source: 'push' });
          } catch (err) {
            console.error('[fkweb] Gagal menyimpan realtime_glog:', err.message);
            return sendFk(res, 'ERROR', transId, null, Buffer.alloc(0), 500);
          }

          return sendFk(res, 'OK', transId, null, Buffer.alloc(0));
        }

        case 'realtime_enroll_data': {
          // Data pendaftaran jari/wajah. Simpan ringkasan ke info mesin bila perlu.
          let json = '';
          try { json = decodeBody(raw).json; } catch { json = ''; }
          let data = null;
          try { data = json ? JSON.parse(json) : null; } catch { data = null; }
          if (data && live.deviceId) {
            const summary = {
              last_enroll_user_id: data.user_id,
              last_enroll_name: data.user_name,
              last_enroll_at: new Date().toISOString(),
            };
            try {
              await require('../../db/pool').execute(
                'UPDATE devices SET last_device_info = ? WHERE id = ?',
                [JSON.stringify(summary).slice(0, 60000), live.deviceId]
              );
            } catch { /* non-fatal */ }
          }

          return sendFk(res, 'OK', transId, null, Buffer.alloc(0));
        }

        default:
          return sendFk(res, 'ERROR_NO_CMD', transId, null, Buffer.alloc(0));
      }
    } catch (err) {
      console.error('[fkweb] Handler error:', err.message);
      return sendFk(res, 'ERROR', transId, null, Buffer.alloc(0), 500);
    }
  });

  return router;
}

function sendFk(res, responseCode, transId, cmdCode, body, status = 200) {
  const headers = {
    'response_code': responseCode,
    'trans_id': String(transId || ''),
    'Content-Length': String(body.length),
    'Content-Type': 'application/octet-stream',
    'Date': new Date().toUTCString(),
  };
  if (cmdCode) headers.cmd_code = cmdCode;

  res.status(status).set(headers).end(body);
}

module.exports = { createFkwebRouter };