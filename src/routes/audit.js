'use strict';

/**
 * API jejak audit (tabel `audit_logs`).
 *
 * Hanya bisa dibaca oleh role yang sudah menangani data master
 * (admin / hr), karena isinya bisa membocorkan perubahan internal.
 */

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const db = require('../db/pool');
const audit = require('../services/audit');

const router = express.Router();

router.use(auth.requireAuth);

/** Daftar jejak audit terbaru. */
router.get(
  '/',
  auth.requirePermission('audit:read'),
  wrap(async (req, res) => {
    const result = await audit.list(req.query);
    res.json({ ok: true, ...result });
  })
);

/** Ringkasan aktivitas per aksi dan per aktor. */
router.get(
  '/summary',
  auth.requirePermission('audit:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await audit.summary(req.query.days || 7) });
  })
);

/** Daftar jenis aksi yang tercatat, untuk filter di UI. */
router.get(
  '/actions',
  auth.requirePermission('audit:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      'SELECT DISTINCT action FROM audit_logs ORDER BY action ASC'
    );
    res.json({ ok: true, data: rows.map((r) => r.action) });
  })
);

module.exports = router;
