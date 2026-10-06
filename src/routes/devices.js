'use strict';

const express = require('express');
const multer = require('multer');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest, notFound } = require('../utils/errors');
const devices = require('../services/devices');
const sync = require('../services/sync');
const devicesRegistry = require('../devices');
const { csvAdapter } = require('../devices/csv/adapter');
const { getLocalAddressHint } = require('../devices/pushhttp/adapter');
const { ZkTcpClient } = require('../devices/zkteco4370/client');
const { mapPinsToEmployees } = require('../devices/zkteco4370/adapter');
const db = require('../db/pool');
const config = require('../config');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.use(auth.requireAuth);

/** Daftar protokol yang didukung + petunjuk konfigurasi tiap mode. */
router.get(
  '/protocols',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    res.json({
      ok: true,
      data: {
        protocols: devicesRegistry.listProtocols(),
        push: {
          port: config.server.pushPort,
          server_address_hint: getLocalAddressHint(),
          auth_token_required: Boolean(config.device.pushAuthToken),
        },
      },
    });
  })
);

router.get(
  '/',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await devices.list({ activeOnly: req.query.active_only === '1' }) });
  })
);

router.get(
  '/status',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: sync.status() });
  })
);

/** Hidup/mati auto-sync tanpa restart (MATI default). */
router.post(
  '/scheduler',
  auth.requirePermission('devices:write'),
  wrap(async (req, res) => {
    const enable = req.body?.enabled === true || req.body?.enabled === 'true' || req.body?.enabled === 1;
    if (enable) {
      sync.startScheduler();
      res.json({ ok: true, data: sync.status(), message: 'Auto-sync DINYALAKAN.' });
    } else {
      sync.stopScheduler();
      res.json({ ok: true, data: sync.status(), message: 'Auto-sync DIMATIKAN.' });
    }
  })
);

router.get(
  '/history',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    const rows = await devices.syncHistory({
      deviceId: req.query.device_id,
      limit: req.query.limit,
    });
    res.json({ ok: true, data: rows });
  })
);

router.get(
  '/:id',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await devices.getOrFail(Number(req.params.id)) });
  })
);

router.post(
  '/',
  auth.requirePermission('devices:write'),
  wrap(async (req, res) => {
    const device = await devices.create(req.body || {});
    res.status(201).json({ ok: true, data: device });
  })
);

router.put(
  '/:id',
  auth.requirePermission('devices:write'),
  wrap(async (req, res) => {
    const device = await devices.update(Number(req.params.id), req.body || {});
    res.json({ ok: true, data: device });
  })
);

router.delete(
  '/:id',
  auth.requirePermission('devices:write'),
  wrap(async (req, res) => {
    const result = await devices.remove(Number(req.params.id));
    res.json({ ok: true, ...result });
  })
);

router.post(
  '/:id/test',
  auth.requirePermission('devices:sync'),
  wrap(async (req, res) => {
    const result = await devices.test(Number(req.params.id));
    res.json(result);
  })
);

/**
 * Sync manual jalan di background: mesin butuh detik-menit, UI langsung
 * dibalas "dijadwalkan" + status bisa dipolling via GET /devices/sync-status.
 * Tanpa ini tombol UI menggantung sampai mesin selesai merespons.
 */
function runSyncBackground(fn) {
  setImmediate(() => {
    fn().catch((err) => console.error('[sync] Background gagal:', err.message));
  });
}

router.post(
  '/:id/sync',
  auth.requirePermission('devices:sync'),
  wrap(async (req, res) => {
    if (sync.status().running) {
      return res.status(202).json({ ok: true, queued: false, message: 'Sinkronisasi masih berjalan, coba lagi setelah selesai.', ...sync.status() });
    }
    runSyncBackground(() =>
      sync.syncDeviceById(Number(req.params.id), {
        regenerateDays: req.body?.regenerate_days ?? 1,
      })
    );
    res.status(202).json({ ok: true, queued: true, message: 'Sinkronisasi berjalan di background.', ...sync.status() });
  })
);

router.post(
  '/sync-all',
  auth.requirePermission('devices:sync'),
  wrap(async (req, res) => {
    if (sync.status().running) {
      return res.status(202).json({ ok: true, queued: false, message: 'Sinkronisasi masih berjalan, coba lagi setelah selesai.', ...sync.status() });
    }
    runSyncBackground(() =>
      sync.syncAll({ regenerateDays: req.body?.regenerate_days ?? 1 })
    );
    res.status(202).json({ ok: true, queued: true, message: 'Sinkronisasi berjalan di background.', ...sync.status() });
  })
);

/** Daftar user yang ada di mesin + status kecocokan dengan master karyawan. */
router.get(
  '/:id/users',
  auth.requirePermission('devices:sync'),
  wrap(async (req, res) => {
    const device = await devices.getOrFail(Number(req.params.id));
    const adapter = devicesRegistry.getAdapter(device.protocol);

    if (typeof adapter.listUsers !== 'function') {
      throw badRequest(`Protokol "${device.protocol}" tidak mendukung pembacaan daftar user.`);
    }

    const users = await adapter.listUsers(device);
    const pins = users.map((u) => String(u.deviceUserId).trim()).filter(Boolean);
    const matched = await mapPinsToEmployees(pins);

    const employeesById = new Map();
    if (matched.size > 0) {
      const ids = [...new Set(matched.values())];
      const rows = await db.queryAll(
        `SELECT id, employee_code, name, department_id FROM employees WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids
      );
      for (const row of rows) employeesById.set(row.id, row);
    }

    const data = users.map((u) => {
      const pin = String(u.deviceUserId).trim();
      const employeeId = matched.get(pin);
      return {
        uid: u.uid,
        device_user_id: pin,
        name_on_device: u.name,
        card_no: u.cardNo,
        matched: Boolean(employeeId),
        employee: employeeId ? employeesById.get(employeeId) : null,
      };
    });

    res.json({
      ok: true,
      data: {
        total: data.length,
        matched: data.filter((d) => d.matched).length,
        unmatched: data.filter((d) => !d.matched).length,
        users: data,
      },
    });
  })
);

/** Hapus seluruh log di mesin (berbahaya, butuh konfirmasi eksplisit). */
router.post(
  '/:id/clear-logs',
  auth.requirePermission('devices:write'),
  wrap(async (req, res) => {
    if (req.body?.confirm !== 'HAPUS LOG MESIN') {
      throw badRequest(
        'Operasi ini menghapus semua log yang tersimpan di mesin dan tidak bisa dibatalkan. ' +
          'Kirim confirm: "HAPUS LOG MESIN" bila benar-benar yakin.'
      );
    }

    const device = await devices.getOrFail(Number(req.params.id));
    const adapter = devicesRegistry.getAdapter(device.protocol);

    if (typeof adapter.clearLogs !== 'function') {
      throw badRequest(`Protokol "${device.protocol}" tidak mendukung penghapusan log jarak jauh.`);
    }

    res.json(await adapter.clearLogs(device));
  })
);

// ---------------------------------------------------------------------------
// Pemeriksaan jaringan (bantu setup awal)
// ---------------------------------------------------------------------------

/**
 * Cek apakah ada mesin fingerprint di sebuah subnet.
 * Port yang diperiksa: 4370 (ZKTeco TCP), 4371, 80/8080 (PUSH HTTP),
 * dan 7000/8000 (beberapa merk lokal).
 */
router.post(
  '/scan',
  auth.requirePermission('devices:read'),
  wrap(async (req, res) => {
    const { subnet, timeout = 600 } = req.body || {};
    const base = String(subnet || '').trim();

    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) {
      throw badRequest('subnet harus format "192.168.1" (tanpa octet terakhir). Contoh: 192.168.1');
    }

    const octets = base.split('.').map(Number);
    if (octets.some((n) => n < 0 || n > 255)) throw badRequest('subnet tidak valid.');

    const ports = [4370, 4371, 80, 8080, 7000, 8000];
    const found = [];
    const timeoutMs = Math.min(3000, Math.max(100, Number(timeout) || 600));

    const tasks = [];
    for (let host = 1; host <= 254; host += 1) {
      const ip = `${octets[0]}.${octets[1]}.${octets[2]}.${host}`;
      for (const port of ports) {
        tasks.push(checkPort(ip, port, timeoutMs).then((open) => (open ? { ip, port } : null)));
      }
    }

    const results = await Promise.all(tasks);
    for (const result of results) {
      if (result) found.push(result);
    }

    // Uji protokol pada kandidat port 4370 supaya hasilnya langsung berguna.
    const zkCandidates = found.filter((f) => f.port === 4370).map((f) => f.ip);
    const identified = [];
    for (const ip of zkCandidates) {
      try {
        const client = new ZkTcpClient({ host: ip, port: 4370, timeout: 4000 });
        await client.connect();
        const firmware = await client.getFirmwareVersion().catch(() => null);
        await client.disconnect().catch(() => {});
        identified.push({ ip, port: 4370, protocol: 'zkteco-tcp', firmware, ok: true });
      } catch (err) {
        identified.push({ ip, port: 4370, protocol: 'zkteco-tcp', ok: false, error: err.message });
      }
    }

    res.json({
      ok: true,
      data: {
        scanned: `${base}.0/24`,
        open_ports: found,
        identified_devices: identified,
        hint:
          found.length === 0
            ? 'Tidak ada port terbuka yang terdeteksi. Pastikan komputer dan mesin berada di subnet yang sama, lalu coba lagi.'
            : 'Port 4370 yang teridentifikasi kemungkinan besar adalah mesin fingerprint. Tambahkan sebagai perangkat dengan protokol zkteco-tcp.',
      },
    });
  })
);

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('node:net');
    const socket = new net.Socket();
    let settled = false;

    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Impor file log manual
// ---------------------------------------------------------------------------

router.post(
  '/import/preview',
  auth.requirePermission('devices:read'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('File tidak ditemukan. Gunakan field "file".');

    const result = await csvAdapter.preview({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      sourceDeviceUserId: req.body?.device_user_id || null,
      defaultDate: req.body?.default_date || null,
    });

    res.json({ ok: true, data: { filename: req.file.originalname, ...result } });
  })
);

router.post(
  '/import',
  auth.requirePermission('devices:sync'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('File tidak ditemukan. Gunakan field "file".');

    const deviceId = req.body?.device_id ? Number(req.body.device_id) : null;
    if (deviceId) await devices.getOrFail(deviceId);

    const result = await csvAdapter.import({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      deviceId,
      sourceDeviceUserId: req.body?.device_user_id || null,
      defaultDate: req.body?.default_date || null,
    });

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: { message: result.message, status: 400 }, data: result });
    }

    res.json({ ok: true, data: { filename: req.file.originalname, ...result } });
  })
);

module.exports = router;
