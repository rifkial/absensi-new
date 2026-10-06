'use strict';

const express = require('express');
const multer = require('multer');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest, asyncHandler } = require('../utils/errors');
const portal = require('../services/employeePortal');

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

// Selfie dinas luar diterima di memori lalu ditulis ke folder privat oleh
// service, sehingga nama berkas tidak pernah berasal dari input pengguna.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: portal.MAX_SELFIE_BYTES + 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!portal.ALLOWED_MIME.includes(file.mimetype)) {
      cb(badRequest('Format foto harus JPG, PNG, atau WEBP.'));
      return;
    }
    cb(null, true);
  },
});

// Bukti reimburse: hanya foto JPG/JPEG atau PDF. Dipisah dari `upload` karena
// selfie tidak boleh menerima PDF, sedangkan bukti reimburse tidak perlu WEBP/PNG.
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: portal.MAX_ATTACHMENT_BYTES + 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!portal.ATTACHMENT_MIME[file.mimetype]) {
      cb(badRequest('Bukti hanya boleh berupa foto JPG/JPEG atau berkas PDF.'));
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
// Reimbursement
// ---------------------------------------------------------------------------

/** Daftar jenis biaya untuk mengisi form pengajuan. */
router.get(
  '/reimburse-options',
  wrap(async (req, res) => {
    res.json({ ok: true, data: portal.REIMBURSE_OPTIONS });
  })
);

/** Pengajuan reimburse milik sendiri. Bukti foto opsional. */
router.get(
  '/reimburses',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.listReimburses(req.selfEmployeeId, req.query) });
  })
);

router.post(
  '/reimburses',
  attachmentUpload.single('attachment'),
  wrap(async (req, res) => {
    const row = await portal.createReimburse(req.selfEmployeeId, req.body || {}, req.file || null);
    res.status(201).json({ ok: true, data: row });
  })
);

router.delete(
  '/reimburses/:reimburseId',
  wrap(async (req, res) => {
    res.json({
      ok: true,
      data: await portal.cancelReimburse(req.selfEmployeeId, req.params.reimburseId),
    });
  })
);

/** Bukti milik sendiri (JPG/PDF); dilayani streaming dari folder privat. */
router.get(
  '/reimburses/:id/attachment',
  wrap(async (req, res) => {
    const file = await portal.getReimburseFile(req.selfEmployeeId, req.params.id);

    // PDF opened inline di tab browser; JPEG juga. Header nosniff mencegah
    // browser menebak-nebak tipe dari isi berkas.
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
  wrap(async (req, res) => {
    res.json({ ok: true, data: await portal.checkOut(req.selfEmployeeId, req.body || {}) });
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
    const file = await portal.getSelfieFile(req.selfEmployeeId, req.params.id);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(file.absolute);
  })
);

module.exports = router;