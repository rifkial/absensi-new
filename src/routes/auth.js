'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const db = require('../db/pool');

const router = express.Router();

router.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw badRequest('username dan password wajib diisi.');

    const result = await auth.login(username, password);
    res.json({ ok: true, ...result });
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
    res.status(201).json({ ok: true, data: user });
  })
);

router.put(
  '/users/:id',
  auth.requireAuth,
  auth.requirePermission('users:manage'),
  wrap(async (req, res) => {
    const user = await auth.updateUser(Number(req.params.id), req.body || {});
    res.json({ ok: true, data: user });
  })
);

/** Daftar unit kerja & jabatan untuk form karyawan. */
router.get(
  '/meta',
  auth.requireAuth,
  wrap(async (req, res) => {
    const [departments, positions, shifts] = await Promise.all([
      db.queryAll('SELECT id, code, name FROM departments ORDER BY name'),
      db.queryAll('SELECT id, code, name FROM positions ORDER BY name'),
      db.queryAll(
        `SELECT id, code, name, start_time, end_time, work_days, late_tolerance_min
           FROM shifts WHERE is_active = 1 ORDER BY start_time, name`
      ),
    ]);

    res.json({ ok: true, data: { departments, positions, shifts } });
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
