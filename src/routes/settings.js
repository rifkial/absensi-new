'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const settings = require('../services/settings');
const channels = require('../services/channels');
const attendance = require('../services/attendance');
const audit = require('../services/audit');

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
    // Ambil nilai lama dulu supaya audit menunjukkan apa yang berubah.
    // Password SMTP ikut tersanitasi oleh audit (tidak pernah disimpan utuh).
    const before = await settings.getStoredMap();

    const data = await settings.updateMany(req.body || {});

    // Jam global dipakai saat menghitung rekap, jadi cache-nya harus dibuang.
    attendance.invalidateGlobalShift();

    // Transport SMTP dibuat ulang bila host/port/user berubah, supaya
    // password baru di UI benar-benar dipakai pada pengiriman berikutnya.
    channels.invalidateMailer();
    require('../services/notify').invalidateStatusCache?.();

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'settings.update',
      entity: 'settings',
      entityId: null,
      before,
      after: data,
    });

    // Port PUSH hanya didengarkan saat server start. Bila portnya berubah,
    // beri tahu lewat pesan supaya admin tidak mengira pengaturan gagal.
    const push = await channels.pushConfig();
    const suffix = push.portNeedsRestart
      ? ` Port PUSH ${push.port} baru berlaku setelah server direstart.`
      : '';

    res.json({
      ok: true,
      data,
      message: 'Pengaturan berhasil disimpan.' + suffix,
      push_port_needs_restart: push.portNeedsRestart,
    });
  })
);

module.exports = router;