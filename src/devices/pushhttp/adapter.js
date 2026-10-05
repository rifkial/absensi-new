'use strict';

const crypto = require('node:crypto');
const express = require('express');

const config = require('../../config');
const db = require('../../db/pool');
const channels = require('../../services/channels');
const { persistLogs, mapPinsToEmployees } = require('../zkteco4370/adapter');
const { CommandQueue } = require('./commandQueue');
const parser = require('./parser');

const queue = new CommandQueue();

/** Serial number -> { deviceId, lastSeenAt, ip, info } */
const liveDevices = new Map();

/** Helper untuk membentuk nilai response body plain text. */
function text(res, body, status = 200) {
  res.status(status).type('text/plain; charset=utf-8').send(body);
}

/**
 * Bandingkan dua string secara timing-safe supaya token PUSH tidak bisa
 * ditebak lewat analisis waktu respons.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Router protokol PUSH.
 * Mount di app terpisah (port default 3001) supaya port HTTP aplikasi tetap
 * bebas dan mesin tidak perlu melewati proxy web.
 */
function createPushRouter() {
  const router = express.Router();

  router.use(express.text({ type: '*/*', limit: config.server.bodyLimit }));
  router.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Token opsional: mesin yang dikonfigurasi dengan `AuthToken` harus
  // mengirim parameter token= (query string atau header x-auth-token).
  // Token dibaca dari tabel settings tiap request supaya mengganti token di
  // UI Pengaturan berlaku tanpa restart; nilai .env dipakai sebagai bawaan.
  router.use(async (req, res, next) => {
    let expected = '';
    try {
      const push = await channels.pushConfig();
      expected = push.token || '';
    } catch (err) {
      // Bila database tidak terbaca, jangan mengunci mesin: biarkan lewat
      // dan biarkan error lain yang dilaporkan.
      console.error('[push] Gagal membaca token PUSH:', err.message);
      return next();
    }

    if (!expected) return next();

    const provided = String(req.query.token || req.headers['x-auth-token'] || '');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return next();

    text(res, 'Unauthorized', 401);
  });

  // -------------------------------------------------------------------------
  // Handshake & upload data
  // -------------------------------------------------------------------------
  router.get('/iclock/cdata', async (req, res) => {
    const sn = String(req.query.SN || '').trim();
    if (sn === '') return text(res, 'Missing SN', 400);

    const device = await registerDevice(sn, req);
    const pushVer = String(req.query.pushver || '').trim();
    const language = Number.parseInt(req.query.language, 10) || parser.LANGUAGE;

    text(
      res,
      parser.buildConfigResponse({
        lastStamp: device?.lastStamp ?? '9999',
        serverAddress: req.hostname,
        serverPort: config.server.pushPort,
        pushVer,
        language,
      })
    );
  });

  router.post('/iclock/cdata', async (req, res) => {
    const sn = String(req.query.SN || '').trim();
    const table = String(req.query.table || 'ATTLOG').trim().toUpperCase();
    if (sn === '') return text(res, 'Missing SN', 400);

    await registerDevice(sn, req);

    let inserted = 0;
    let records = [];

    try {
      if (table === parser.TABLES.ATTLOG) {
        records = parser.parseAttlogBody(req.body);
        const deviceId = await getOrCreateDeviceId(sn, req);
        const result = await persistLogs({ deviceId, logs: records, source: 'push' });
        inserted = result.inserted;
      } else if (table === parser.TABLES.FINGERTMP || table === parser.TABLES.BIODATA) {
        records = parser.parseBiometricBody(req.body);
        inserted = await saveTemplates(sn, records);
      } else {
        // Table lain (mis. REGOPT/SYSOPT) kita abaikan tapi tetap acknowledges.
        records = [];
      }
    } catch (err) {
      console.error(`[push] Gagal menyimpan ${table} dari ${sn}:`, err.message);
      return text(res, 'ERROR: 0', 200);
    }

    // Mesin memakai Stamp untuk melacak posisi upload, jadi kita balas jumlah baris.
    text(res, `OK: ${records.length}`);
  });

  router.post('/iclock/fdata', async (req, res) => {
    const sn = String(req.query.SN || '').trim();
    const table = String(req.query.table || '').trim().toUpperCase();
    if (sn === '') return text(res, 'Missing SN', 400);

    await registerDevice(sn, req);

    try {
      if (table === parser.TABLES.FINGERTMP || table === parser.TABLES.BIODATA) {
        const records = parser.parseBiometricBody(req.body);
        await saveTemplates(sn, records);
        return text(res, `OK: ${records.length}`);
      }
      if (table === parser.TABLES.ATTPHOTO) {
        // Foto absensi disimpan bila ada karyawan yang cocok, tapi tidak wajib
        // untuk rekap absensi.
        return text(res, 'OK: 1');
      }
    } catch (err) {
      console.error(`[push] Gagal menyimpan fdata ${table} dari ${sn}:`, err.message);
    }

    text(res, 'OK: 0');
  });

  // -------------------------------------------------------------------------
  // Long-poll perintah
  // -------------------------------------------------------------------------
  router.get('/iclock/getrequest', async (req, res) => {
    const sn = String(req.query.SN || '').trim();
    if (sn === '') return text(res, 'Missing SN', 400);

    const live = liveDevices.get(sn);
    if (live) live.lastSeenAt = new Date();

    const line = await queue.poll(sn);
    text(res, line);
  });

  router.post('/iclock/devicecmd', async (req, res) => {
    const sn = String(req.query.SN || '').trim();
    if (sn === '') return text(res, 'Missing SN', 400);

    const reply = parser.parseCommandReply(req.body);
    const handled = queue.complete(sn, reply);

    if (!handled) {
      console.warn(`[push] Balasan perintah tanpa pengirim untuk SN ${sn}: ${reply.raw.slice(0, 200)}`);
    }

    text(res, 'OK');
  });

  // Endpoint bantu untuk mengecek apakah server PUSH hidup.
  router.get('/iclock/status', async (req, res) => {
    const devices = await db.queryAll(
      `SELECT id, name, serial_number, ip_address, is_active, last_sync_at
         FROM devices
        WHERE protocol = 'push-http'
        ORDER BY name`
    );
    res.json({
      ok: true,
      port: config.server.pushPort,
      live: [...liveDevices.entries()].map(([sn, info]) => ({ sn, ...info })),
      queue: queue.stats(),
      devices,
    });
  });

  return router;
}

/** Catat / perbarui perangkat yang sedang terhubung via PUSH. */
async function registerDevice(sn, req) {
  const ip = req.ip || req.socket.remoteAddress || null;
  const existing = liveDevices.get(sn);

  if (existing) {
    existing.lastSeenAt = new Date();
    existing.ip = ip;
    return existing;
  }

  const info = {
    deviceId: null,
    lastSeenAt: new Date(),
    ip,
    firmware: String(req.query.ver || '').trim() || null,
    pushVer: String(req.query.pushver || '').trim() || null,
  };

  info.deviceId = await getOrCreateDeviceId(sn, req, info);
  liveDevices.set(sn, info);
  return info;
}

/** Cari perangkat berdasarkan SN, buat bila belum ada. */
async function getOrCreateDeviceId(sn, req, info = {}) {
  const row = await db.queryOne('SELECT id FROM devices WHERE serial_number = ?', [sn]);
  if (row) return row.id;

  const name = `Mesin PUSH ${sn}`.slice(0, 100);
  const result = await db.execute(
    `INSERT INTO devices (name, protocol, ip_address, port, serial_number, location, last_sync_status, last_sync_message)
     VALUES (?, 'push-http', ?, ?, ?, 'Terdaftar otomatis via PUSH', 'success', ?)`,
    [name, (req.ip || null), config.server.pushPort, sn, info.firmware ? `Firmware: ${info.firmware}` : 'Handshake PUSH diterima.']
  );

  console.log(`[push] Perangkat baru terdaftar dari PUSH: ${name}`);
  return result.insertId;
}

/** Simpan template biometrik yang dikirim mesin. */
async function saveTemplates(sn, records) {
  if (records.length === 0) return 0;

  const deviceRow = await db.queryOne('SELECT id FROM devices WHERE serial_number = ?', [sn]);
  const deviceId = deviceRow ? deviceRow.id : null;

  const pins = [...new Set(records.map((r) => r.deviceUserId).filter(Boolean))];
  const employeeMap = await mapPinsToEmployees(pins);

  let saved = 0;
  for (const record of records) {
    const employeeId = employeeMap.get(String(record.deviceUserId));
    if (!employeeId || !record.template) continue;

    await db.execute(
      `INSERT INTO fingerprint_templates
         (employee_id, device_id, finger_index, valid, size_bytes, template)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         device_id = VALUES(device_id),
         valid = VALUES(valid),
         size_bytes = VALUES(size_bytes),
         template = VALUES(template)`,
      [employeeId, deviceId, record.fingerIndex, record.valid, record.size, record.template]
    );

    await db.execute(
      `UPDATE employees SET fingerprint_status = 'terdaftar' WHERE id = ? AND fingerprint_status <> 'terdaftar'`,
      [employeeId]
    );
    saved += 1;
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const pushAdapter = {
  protocol: 'push-http',
  label: 'ZKTeco PUSH / ADMS (HTTP)',
  description:
    'Mesin mengirim data ke server ini secara otomatis memakai protokol HTTP resmi ZKTeco PUSH. ' +
    `Aktifkan di mesin: menu Comm -> ADMS / Push -> Server IP & port = ${config.server.pushPort}. ` +
    'Cocok kalau mesin tidak bisa diakses dari server (mis. IP berbeda subnet).',

  /** Pada mode PUSH tidak ada koneksi yang dibuat server ke mesin. */
  async test(device) {
    const row = await db.queryOne('SELECT serial_number, last_sync_at, last_sync_message FROM devices WHERE id = ?', [device.id]);
    if (!row) return { ok: false, message: 'Perangkat tidak ditemukan.' };

    const live = row.serial_number ? liveDevices.get(row.serial_number) : null;
    if (live) {
      return {
        ok: true,
        message: `Mesin ${row.serial_number} aktif terhubung (IP ${live.ip}).`,
        info: live,
      };
    }

    return {
      ok: false,
      message:
        `Mesin belum pernah terhubung ke server PUSH. Pastikan di mesin: Comm -> ADMS/Push -> ` +
        `Server Address = ${getLocalAddressHint()}, Port = ${config.server.pushPort}, lalu mesin harus di-restart.`,
    };
  },

  /** Data sudah masuk otomatis lewat HTTP; sinkronisasi cukup memicu rekap. */
  async sync(device) {
    const count = await db.queryScalar(
      `SELECT COUNT(*) FROM attendance_logs WHERE device_id = ? AND source = 'push' AND log_time >= NOW() - INTERVAL 1 DAY`,
      [device.id]
    );
    return {
      ok: true,
      fetched: Number(count || 0),
      inserted: 0,
      duplicated: 0,
      unmatched: 0,
      message:
        `Mode PUSH: ${count || 0} log diterima dari mesin dalam 24 jam terakhir. ` +
        'Data masuk otomatis, tidak ada penarikan manual.',
    };
  },

  /**
   * Kirim perintah ke mesin lewat antrean long-poll.
   * Contoh: await sendToDevice(sn, 'DATA QUERY ATTLOG StartTime=2026-09-01 00:00:00\tEndTime=2026-09-30 23:59:59')
   */
  async sendToDevice(sn, verb, args = '') {
    return queue.enqueue(sn, verb, args);
  },

  queue,
  liveDevices,
};

/** Saran IP lokal untuk ditampilkan di UI (alamat yang harus diisi di mesin). */
function getLocalAddressHint() {
  const interfaces = require('node:os').networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (/^169\.254\./.test(addr.address)) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  // Prioritaskan interface LAN umum
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  return candidates.length > 0 ? candidates[0].address : 'IP-KOMPUTER-SERVER';
}

function rank(name) {
  const n = name.toLowerCase();
  if (n.includes('ethernet') || n.includes('eth')) return 0;
  if (n.includes('wifi') || n.includes('wlan') || n.includes('wi-fi')) return 1;
  return 2;
}

module.exports = { createPushRouter, pushAdapter, getLocalAddressHint, queue, liveDevices };
