'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest, tooManyRequests } = require('../utils/errors');
const db = require('../db/pool');
const audit = require('../services/audit');
const settings = require('../services/settings');
const throttle = require('../services/loginThrottle');
const leaveCatalog = require('../services/leaveCatalog');

const router = express.Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw badRequest('username dan password wajib diisi.');

    // Pembatas percobaan: menahan brute force tanpa mengganggu salah ketik
    // satu-dua kali. Pesan 429 dibuat manual karena utils/errors tidak punya
    // helper untuk kode ini.
    const ip = audit.ipOf(req);
    throttle.applySettings(await settings.getStoredMap().catch(() => ({})));

    if (throttle.getPolicy().enabled) {
      const gate = throttle.check(ip, username);
      if (!gate.allowed) {
        await audit.record({
          ip,
          action: gate.reason === 'locked' ? 'auth.login_locked' : 'auth.login_throttled',
          entity: 'app_users',
          detail: { alasan: gate.reason, tunggu_detik: gate.retryAfter },
        });

        res.setHeader('Retry-After', String(gate.retryAfter));
        throw tooManyRequests(
          gate.reason === 'locked'
            ? `Akun terkunci sementara karena terlalu banyak percobaan gagal. Coba lagi dalam ${Math.ceil(gate.retryAfter / 60)} menit.`
            : `Terlalu banyak percobaan login. Coba lagi dalam ${gate.retryAfter} detik.`,
          gate.retryAfter
        );
      }
    }

    try {
      const result = await auth.login(username, password);
      if (throttle.getPolicy().enabled) throttle.registerSuccess(ip, username);

      await audit.record({
        userId: result.user.id,
        ip,
        action: 'auth.login',
        entity: 'app_users',
        entityId: result.user.id,
        detail: { username: result.user.username, role: result.user.role },
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      if (throttle.getPolicy().enabled) throttle.registerFailure(ip, username);

      // Login gagal tetap dicatat, tapi username yang diketik dan passwordnya
      // tidak disimpan agar log ini tidak ikut jadi daftar kandidat password.
      await audit.record({
        ip,
        action: 'auth.login_failed',
        entity: 'app_users',
        detail: { alasan: err.message },
      });
      throw err;
    }
  })
);

router.get(
  '/me',
  auth.requireAuth,
  wrap(async (req, res) => {
    res.json({ ok: true, user: req.user, permissions: permissionsFor(req.user.role) });
  })
);

router.post(
  '/change-password',
  auth.requireAuth,
  wrap(async (req, res) => {
    const { current_password: current, new_password: next } = req.body || {};
    if (!current || !next) throw badRequest('current_password dan new_password wajib diisi.');

    const result = await auth.changeOwnPassword(req.user.id, current, next);

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'auth.password_change',
      entity: 'app_users',
      entityId: req.user.id,
      detail: { username: req.user.username, oleh: 'pengguna sendiri' },
    });

    res.json(result);
  })
);

router.get(
  '/users',
  auth.requireAuth,
  auth.requirePermission('users:manage'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await auth.listUsers() });
  })
);

router.post(
  '/users',
  auth.requireAuth,
  auth.requirePermission('users:manage'),
  wrap(async (req, res) => {
    const user = await auth.createUser(req.body || {}, req.user.id);

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'user.create',
      entity: 'app_users',
      entityId: user.id,
      detail: user,
    });

    res.status(201).json({ ok: true, data: user });
  })
);

router.put(
  '/users/:id',
  auth.requireAuth,
  auth.requirePermission('users:manage'),
  wrap(async (req, res) => {
    const before = await db.queryOne(
      'SELECT username, full_name, role, employee_id, is_active FROM app_users WHERE id = ?',
      [Number(req.params.id)]
    );

    const user = await auth.updateUser(Number(req.params.id), req.body || {});

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'user.update',
      entity: 'app_users',
      entityId: user.id,
      before,
      after: user,
      detail: { reset_password: Boolean(req.body?.password) },
    });

    res.json({ ok: true, data: user });
  })
);

/** Daftar unit kerja & jabatan untuk form karyawan. */
router.get(
  '/meta',
  auth.requireAuth,
  wrap(async (req, res) => {
    const [departments, positions, shifts, devices] = await Promise.all([
      db.queryAll('SELECT id, code, name FROM departments ORDER BY name'),
      db.queryAll('SELECT id, code, name FROM positions ORDER BY name'),
      db.queryAll(
        `SELECT id, code, name, start_time, end_time, work_days, late_tolerance_min
           FROM shifts WHERE is_active = 1 ORDER BY start_time, name`
      ),
      // Untuk dropdown "Mesin Fingerprint" di form karyawan. Mesin nonaktif
      // tetap dikirim supaya karyawan yang sudah ditunjuk mesin itu tidak
      // kehilangan nilai select-nya saat form dibuka.
      db.queryAll(
        `SELECT id, name, location, protocol, serial_number, is_active
           FROM devices ORDER BY is_active DESC, name`
      ),
    ]);

    res.json({
      ok: true,
      data: {
        departments,
        positions,
        shifts,
        devices,
        // Katalog pengajuan untuk form admin/HR (izin, cuti, dinas).
        leave_categories: leaveCatalog.toPublicOptions(),
      },
    });
  })
);

function permissionsFor(role) {
  const out = {};
  for (const [action, roles] of Object.entries(auth.PERMISSIONS)) {
    out[action] = roles.includes(role);
  }
  return out;
}

module.exports = router;
