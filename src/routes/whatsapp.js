'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const waSelf = require('../services/whatsappSelf');
const audit = require('../services/audit');

const router = express.Router();

router.use(auth.requireAuth);

/** Status sesi nomor sendiri (butuh login + izin kirim notif). */
router.get(
  '/self/status',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await waSelf.status() });
  })
);

/** Mulai sesi (tampilkan QR). */
router.post(
  '/self/start',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const data = await waSelf.start({ force: req.body?.force === true });
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'whatsapp.self_start',
      entity: 'whatsapp',
      detail: { state: data.state },
    });
    res.json({ ok: true, data });
  })
);

/** Hentikan sesi (sesi login tetap tersimpan). */
router.post(
  '/self/stop',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await waSelf.stop() });
  })
);

/** Keluar + hapus sesi (WA perlu scan ulang). */
router.post(
  '/self/logout',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const data = await waSelf.logout();
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'whatsapp.self_logout',
      entity: 'whatsapp',
    });
    res.json({ ok: true, data });
  })
);

/** Kirim uji coba lewat nomor sendiri. */
router.post(
  '/self/test',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const target = String(req.body?.target || '').trim();
    const message = String(req.body?.message || 'Uji WhatsApp nomor sendiri: pesan terkirim.').slice(0, 1000);
    if (!target) {
      return res.status(400).json({ ok: false, error: { message: 'target wajib diisi (format 62812xxxxxxx).' } });
    }
    const result = await waSelf.send({ target, message });
    res.json({ ok: result.ok === true, data: result });
  })
);

module.exports = router;
