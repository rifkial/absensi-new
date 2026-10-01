'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const settings = require('../services/settings');
const attendance = require('../services/attendance');

const router = express.Router();

router.use(auth.requireAuth);

router.get(
  '/',
  auth.requirePermission('settings:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await settings.getAll({ refresh: req.query.refresh === '1' }) });
  })
);

router.put(
  '/',
  auth.requirePermission('settings:write'),
  wrap(async (req, res) => {
    const data = await settings.updateMany(req.body || {});

    // Jam global dipakai saat menghitung rekap, jadi cache-nya harus dibuang.
    attendance.invalidateGlobalShift();

    res.json({ ok: true, data, message: 'Pengaturan berhasil disimpan.' });
  })
);

module.exports = router;