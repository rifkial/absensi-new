'use strict';

const express = require('express');
const multer = require('multer');

const auth = require('../middleware/auth');
const db = require('../db/pool');
const { wrap } = require('../middleware/error');
const { badRequest, asyncHandler } = require('../utils/errors');
const portal = require('../services/employeePortal');
const realtime = require('../services/realtime');

const router = express.Router();

/**
 * Semua route di bawah ini hanya untuk akun yang punya akses mandiri
 * (role employee, atau admin/HR dengan employee_id eksplisit).
 * requireSelf menolak role lain seperti operator/viewer.
 */
router.use(auth.requireAuth, auth.requireSelf);

// Admin/HR boleh memakai endpoint ini untuk memeriksa hasil seorang karyawan,
// tetapi harus menyebut employee_id secara eksplisit. Role employee otomatis
// terkunci ke akunnya lewat req.employeeId.
router.use(
  asyncHandler(async (req, res, next) => {
    req.selfEmployeeId = await auth.resolveSelfEmployeeId(req);
    next();
  })
);

// Selfie diterima di memori lalu ditulis ke folder privat oleh service,
// sehingga nama berkas tidak pernah berasal dari input pengguna.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: portal.MAX_SELFIE_BYTES + 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!portal.ALLOWED_MIME.includes(file.mimetype)) {
      cb(badRequest('Format selfie harus JPG, PNG, atau WEBP.'));
      return;
    }
    cb(null, true);
  },
});

/** Profil + shift efektif milik pengguna yang sedang login. */
router.get(
  '/profile',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.getProfile(req.user, req.selfEmployeeId) });
  })
);

/** Rekap kehadiran milik sendiri saja. */
router.get(
  '/attendance',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.getMyAttendance(req.selfEmployeeId, req.query) });
  })
);

/** Jadwal & shift milik sendiri (jadwal per tanggal + shift default). */
router.get(
  '/schedule',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.getMySchedule(req.selfEmployeeId, req.query) });
  })
);

/** Ringkasan hari ini + status kelayakan check-in dinas luar. */
router.get(
  '/today',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.getToday(req.selfEmployeeId) });
  })
);

// ---------------------------------------------------------------------------
// Pengajuan izin / sakit / cuti
// ---------------------------------------------------------------------------

router.get(
  '/leaves',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.listLeaves(req.selfEmployeeId, req.query) });
  })
);

router.post(
  '/leaves',
  wrap(async (req, res) => {
    const row = await portal.createLeave(req.selfEmployeeId, req.body || {});
    try {
      const emp = await db.queryOne('SELECT name FROM employees WHERE id = ?', [req.selfEmployeeId]);
      await realtime.onLeaveSubmitted(row, emp ? emp.name : 'Karyawan');
    } catch {
      // abaikan
    }
    res.status(201).json({ ok: true, data: row });
  })
);

router.delete(
  '/leaves/:leaveId',
  wrap(async (req, res) => {
    res.json({
      ok: true,
      data: await portal.cancelLeave(req.selfEmployeeId, req.params.leaveId),
    });
  })
);

// ---------------------------------------------------------------------------
// Reimburse biaya perjalanan dinas
// ---------------------------------------------------------------------------

router.get(
  '/reimburses',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.listReimburses(req.selfEmployeeId, req.query) });
  })
);

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: portal.MAX_RECEIPT_BYTES + 1024, files: 21 },
  fileFilter(req, file, cb) {
    if (!portal.ALLOWED_RECEIPT_MIME.includes(file.mimetype)) {
      cb(badRequest('Bukti harus JPG, PNG, WEBP, atau PDF.'));
      return;
    }
    cb(null, true);
  },
});

router.post(
  '/reimburses',
  receiptUpload.single('receipt'),
  wrap(async (req, res) => {
    const row = await portal.createReimburse(req.selfEmployeeId, req.body || {}, req.file || null);
    try {
      const emp = await db.queryOne('SELECT name FROM employees WHERE id = ?', [req.selfEmployeeId]);
      await realtime.onReimburseSubmitted(row, emp ? emp.name : 'Karyawan');
    } catch {
      // abaikan
    }
    res.status(201).json({ ok: true, data: row });
  })
);

/** Kirim banyak item reimburse sekaligus (multi-form). */
router.post(
  '/reimburses/batch',
  receiptUpload.any(),
  wrap(async (req, res) => {
    let items = req.body?.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        throw badRequest('items tidak valid (harus JSON array).');
      }
    }
    // File sejajar index item: receipts[0] untuk items[0], dst.
    const filesByIndex = {};
    for (const f of req.files || []) {
      const m = /^receipts\[(\d+)\]$/.exec(f.fieldname || '');
      if (m) filesByIndex[Number(m[1])] = f;
    }
    const files = (Array.isArray(items) ? items : []).map((_, i) => filesByIndex[i] || null);
    const rows = await portal.createReimburseBatch(req.selfEmployeeId, items, files);
    try {
      const emp = await db.queryOne('SELECT name FROM employees WHERE id = ?', [req.selfEmployeeId]);
      const name = emp ? emp.name : 'Karyawan';
      for (const row of rows) {
        await realtime.onReimburseSubmitted(row, name);
      }
    } catch {
      // abaikan
    }
    res.status(201).json({ ok: true, data: rows, count: rows.length });
  })
);

/** Unduh bukti struk/nota milik sendiri. */
router.get(
  '/reimburses/:id/receipt',
  wrap(async (req, res) => {
    const file = await portal.getReceiptFile(req.selfEmployeeId, req.params.id);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `inline; filename="${file.name}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(file.absolute);
  })
);

// ---------------------------------------------------------------------------
// Dinas luar kota
// ---------------------------------------------------------------------------

router.post(
  '/duty-checkins',
  upload.single('selfie'),
  wrap(async (req, res) => {
    const row = await portal.checkIn(req.selfEmployeeId, req.body || {}, req.file || null);
    res.status(201).json({ ok: true, data: row });
  })
);

router.post(
  '/duty-checkins/check-out',
  upload.single('selfie'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.checkOut(req.selfEmployeeId, req.body || {}, req.file || null) });
  })
);

router.get(
  '/duty-checkins',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.listDuty(req.selfEmployeeId, req.query) });
  })
);

/** Selfie milik sendiri; dilayani streaming dari folder privat. */
router.get(
  '/duty-checkins/:id/selfie',
  wrap(async (req, res) => {
    const file = await portal.getSelfieFile(req.selfEmployeeId, req.params.id, 'in');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(file.absolute);
  })
);

/** Selfie check-out milik sendiri. */
router.get(
  '/duty-checkins/:id/selfie-out',
  wrap(async (req, res) => {
    const file = await portal.getSelfieFile(req.selfEmployeeId, req.params.id, 'out');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(file.absolute);
  })
);

module.exports = router;