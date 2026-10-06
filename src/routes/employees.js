'use strict';

const express = require('express');
const multer = require('multer');

const db = require('../db/pool');
const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest, notFound } = require('../utils/errors');
const employees = require('../services/employees');
const attendance = require('../services/attendance');
const leaveCatalog = require('../services/leaveCatalog');
const leaveQuota = require('../services/leaveQuota');
const audit = require('../services/audit');
const realtime = require('../services/realtime');
const { parseCsv, detectDelimiter } = require('../devices/csv/adapter');
const { toDate } = require('../utils/date');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(auth.requireAuth);

router.get(
  '/',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    const result = await employees.list(req.query);
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/stats',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await employees.stats() });
  })
);

router.get(
  '/template',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="template-karyawan.csv"');
    res.send('﻿' + employees.EMPLOYEE_CSV_TEMPLATE);
  })
);

router.get(
  '/:id',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    const employee = await employees.getOrFail(Number(req.params.id));
    res.json({ ok: true, data: employee });
  })
);

router.post(
  '/',
  auth.requirePermission('employees:write'),
  wrap(async (req, res) => {
    const employee = await employees.create(req.body || {});

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'employee.create',
      entity: 'employees',
      entityId: employee.id,
      detail: employee,
    });

    res.status(201).json({ ok: true, data: employee });
  })
);

router.put(
  '/:id',
  auth.requirePermission('employees:write'),
  wrap(async (req, res) => {
    const before = await employees.getOrFail(Number(req.params.id));
    const employee = await employees.update(Number(req.params.id), req.body || {}, {
      actorId: req.user.id,
    });

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'employee.update',
      entity: 'employees',
      entityId: employee.id,
      before,
      after: employee,
    });

    res.json({ ok: true, data: employee });
  })
);

// ---------------------------------------------------------------------------
// Jatah cuti tahunan
// ---------------------------------------------------------------------------

/** Ringkasan jatah cuti tahunan seorang karyawan. */
router.get(
  '/:id/leave-quota',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    const employeeId = Number(req.params.id);
    await employees.getOrFail(employeeId);

    const [summary, logs] = await Promise.all([
      leaveQuota.getSummary(employeeId),
      leaveQuota.history(employeeId, { limit: req.query.limit || 50 }),
    ]);

    res.json({ ok: true, data: { ...summary, logs } });
  })
);

/**
 * Kembalikan jatah cuti tahunan ke jumlah semula.
 * Status pengajuan yang sudah disetujui tidak diubah, hanya hitungannya.
 */
router.post(
  '/:id/leave-quota/reset',
  auth.requirePermission('employees:write'),
  wrap(async (req, res) => {
    const employeeId = Number(req.params.id);
    const employee = await employees.getOrFail(employeeId);

    const result = await leaveQuota.reset(employeeId, {
      actorId: req.user.id,
      reason: req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : 'Reset jatah cuti oleh admin/HR',
    });

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'leave_quota.reset',
      entity: 'employees',
      entityId: employeeId,
      detail: {
        employee: `${employee.employee_code} - ${employee.name}`,
        jatah: result.quota,
        terpakai_sebelum: result.used_before,
        terpakai_setelah: result.used,
      },
    });

    res.json({
      ok: true,
      message: result.changed
        ? `Jatah cuti tahunan ${employee.name} dikembalikan menjadi ${result.remaining} hari.`
        : `Jatah cuti tahunan ${employee.name} sudah penuh (${result.remaining} hari), tidak ada yang dikembalikan.`,
      data: result,
    });
  })
);

router.delete(
  '/:id',
  auth.requirePermission('employees:delete'),
  wrap(async (req, res) => {
    const result = await employees.remove(Number(req.params.id));

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: result.archived ? 'employee.archive' : 'employee.delete',
      entity: 'employees',
      entityId: result.employee.id,
      detail: {
        employee: `${result.employee.employee_code} - ${result.employee.name}`,
        catatan: result.message,
      },
    });

    res.json({ ok: true, ...result });
  })
);

/** Impor massal karyawan dari file CSV. */
router.post(
  '/import',
  auth.requirePermission('employees:write'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('File tidak ditemukan. Gunakan field "file".');

    const text = decodeUpload(req.file.buffer);
    const delimiter = req.body?.delimiter ? String(req.body.delimiter) : detectDelimiter(text.slice(0, 4000));
    const rows = parseCsv(text, delimiter);

    if (rows.length < 2) throw badRequest('File tidak berisi data. Minimal harus ada header + 1 baris.');

    const result = await employees.importFromRows(rows);
    res.json({ ok: true, data: result });
  })
);

// ---------------------------------------------------------------------------
// Jadwal kerja per karyawan per tanggal
// ---------------------------------------------------------------------------

router.get(
  '/:id/schedules',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const where = ['employee_id = ?'];
    const params = [id];

    const from = toDate(req.query.from);
    const to = toDate(req.query.to);
    if (from) {
      where.push('work_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('work_date <= ?');
      params.push(to);
    }

    const rows = await db.queryAll(
      `SELECT sc.*, s.code AS shift_code, s.name AS shift_name,
              s.start_time, s.end_time, s.late_tolerance_min
         FROM schedules sc
         LEFT JOIN shifts s ON s.id = sc.shift_id
        WHERE ${where.join(' AND ')}
        ORDER BY sc.work_date ASC`,
      params
    );

    res.json({ ok: true, data: rows });
  })
);

/** Simpan jadwal untuk banyak tanggal sekaligus (mis. cuti 3 hari). */
router.post(
  '/:id/schedules',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const employeeId = Number(req.params.id);
    await employees.getOrFail(employeeId);

    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entries.length === 0) throw badRequest('entries harus berupa array (minimal satu entri).');

    const saved = [];
    for (const entry of entries) {
      const workDate = toDate(entry.work_date);
      if (!workDate) throw badRequest(`work_date "${entry.work_date}" tidak valid.`);

      const dayType = ['kerja', 'libur', 'cuti'].includes(entry.day_type) ? entry.day_type : 'kerja';
      const shiftId = entry.shift_id ? Number(entry.shift_id) : null;

      await db.execute(
        `INSERT INTO schedules (employee_id, work_date, shift_id, day_type, note)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), day_type = VALUES(day_type), note = VALUES(note)`,
        [employeeId, workDate, shiftId, dayType, entry.note || null]
      );
      saved.push(workDate);
    }

    res.json({ ok: true, data: { saved: saved.length, dates: saved } });
  })
);

router.delete(
  '/:id/schedules/:date',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const workDate = toDate(req.params.date);
    if (!workDate) throw badRequest('Tanggal tidak valid.');

    const result = await db.execute('DELETE FROM schedules WHERE employee_id = ? AND work_date = ?', [
      Number(req.params.id),
      workDate,
    ]);

    if (result.affectedRows === 0) throw notFound('Jadwal tidak ditemukan.');
    res.json({ ok: true, message: 'Jadwal dihapus.' });
  })
);

// ---------------------------------------------------------------------------
// Pengajuan izin / sakit / cuti
// ---------------------------------------------------------------------------

router.get(
  '/:id/leaves',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      `SELECT * FROM leave_requests WHERE employee_id = ? ORDER BY start_date DESC LIMIT 100`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, data: rows });
  })
);

router.post(
  '/:id/leaves',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const employeeId = Number(req.params.id);
    await employees.getOrFail(employeeId);

    const payload = req.body || {};
    const categoryKey = payload.category ? String(payload.category) : '';
    const subtypeKey = payload.subtype ? String(payload.subtype) : '';

    const category = categoryKey ? leaveCatalog.findCategory(categoryKey) : null;
    if (categoryKey && !category) {
      throw badRequest(
        `Kategori pengajuan tidak valid. Pilihan: ${leaveCatalog.CATEGORIES.map((c) => c.key).join(', ')}.`
      );
    }

    const subtype = leaveCatalog.findSubtype(subtypeKey);
    if (subtypeKey && !subtype) {
      throw badRequest('Jenis pengajuan tidak valid untuk kategori yang dipilih.');
    }
    if (subtype && category && subtype.category !== category.key) {
      throw badRequest(`Jenis "${subtype.label}" tidak termasuk kategori ${category.label}.`);
    }
    if (!subtype) {
      throw badRequest(
        `Jenis pengajuan wajib dipilih. Pilihan kategori: ${leaveCatalog.CATEGORIES.map((c) => c.label).join(', ')}.`
      );
    }

    const startDate = toDate(payload.start_date);
    if (!startDate) throw badRequest('Tanggal mulai wajib diisi.');

    const endDate = subtype.single_day ? startDate : toDate(payload.end_date || startDate);
    if (!endDate) throw badRequest('Tanggal selesai tidak valid.');
    if (endDate < startDate) throw badRequest('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');

    if (!subtype.needs_place && payload.place) {
      throw badRequest('Lokasi hanya diisi untuk pengajuan dinas.');
    }
    const place = subtype.needs_place
      ? String(payload.place || '').trim().slice(0, 150) || null
      : null;
    if (subtype.needs_place && !place) {
      throw badRequest(`Lokasi/tujuan wajib diisi untuk ${subtype.label}.`);
    }

    const reason = payload.reason ? String(payload.reason).trim().slice(0, 500) : null;

    // Admin/HR boleh mencatat pengajuan atas nama karyawan. Status awal
    // default 'pending' (ikut alur persetujuan), atau langsung 'approved'
    // bila pengajuan dicatat beserta persetujuannya.
    const initialStatus = payload.status === 'approved' ? 'approved' : 'pending';
    const reviewNote = payload.review_note
      ? String(payload.review_note).trim().slice(0, 500)
      : null;

    const result = await db.execute(
      `INSERT INTO leave_requests
         (employee_id, leave_type, subtype, place, start_date, end_date, reason,
          status, reviewed_by, reviewed_at, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${initialStatus === 'approved' ? 'NOW()' : 'NULL'}, ?)`,
      [
        employeeId,
        subtype.leave_type,
        subtype.key,
        place,
        startDate,
        endDate,
        reason,
        initialStatus,
        initialStatus === 'approved' ? req.user.id : null,
        reviewNote,
      ]
    );

    const row = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [result.insertId]);

    // Hitung dulu jumlah hari kerja yang akan dipotong dari jatah cuti tahunan
    // supaya angkanya final ketika pengajuan ini disetujui.
    await leaveQuota.prepareLeave(row);

    // Pengajuan yang langsung disetujui harus langsung masuk ke rekap harian
    // supaya status izin/cuti/dinas di laporan tidak menunggu backfill.
    if (row.status === 'approved') {
      await attendance.generate({ from: startDate, to: endDate, employeeId });
      await leaveQuota.applyLeaveChange(row, 'potong', {
        actorId: req.user.id,
        reason: 'Pengajuan cuti tahunan dicatat langsung sebagai approved',
      });
    }

    // Notif realtime ke admin/HR bila dinas; ke karyawan bila langsung approved.
    try {
      const emp = await employees.getOrFail(employeeId);
      await realtime.onLeaveSubmitted(row, emp.name);
      if (row.status === 'approved') {
        await realtime.onLeaveReviewed(row, req.user.full_name || req.user.username, 'approved');
      }
    } catch {
      // notif gagal tidak boleh menggagalkan simpan pengajuan
    }

    res.status(201).json({ ok: true, data: decorateLeave(row) });
  })
);

router.put(
  '/leaves/:leaveId/review',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const decision = req.body?.status;
    if (!['approved', 'rejected', 'pending'].includes(decision)) {
      throw badRequest("status harus 'approved', 'rejected', atau 'pending'.");
    }

    const leaveId = Number(req.params.leaveId);
    const before = await db.queryOne(
      `SELECT lr.*, e.name AS employee_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        WHERE lr.id = ?`,
      [leaveId]
    );
    if (!before) throw notFound('Pengajuan tidak ditemukan.');

    // Pengajuan lama mungkin belum punya quota_days, jadi dihitung sekarang
    // bila jenisnya cuti tahunan.
    if (leaveQuota.usesQuota(before) && Number(before.quota_days || 0) === 0) {
      await leaveQuota.prepareLeave(before);
    }

    // Cuti tahunan tidak boleh disetujui bila jatah sudah habis, kecuali admin
    // mengirim force: true (mis. persetujuan karena keadaan mendesak).
    if (decision === 'approved' && before.status !== 'approved') {
      const check = await leaveQuota.checkQuota(before, { force: req.body?.force === true });
      if (!check.ok) throw badRequest(check.message);
    }

    const result = await db.execute(
      'UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?',
      [decision, req.user.id, req.body?.review_note || null, leaveId]
    );

    if (result.affectedRows === 0) throw notFound('Pengajuan tidak ditemukan.');

    const row = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [leaveId]);

    // Jatah cuti tahunan mengikuti perpindahan status: disetujui memotong,
    // ditolak/dibatalkan/ditarik kembali mengembalikan jumlah yang dipotong.
    if (before.status !== 'approved' && decision === 'approved') {
      await leaveQuota.applyLeaveChange(row, 'potong', {
        actorId: req.user.id,
        reason: 'Pengajuan cuti tahunan disetujui',
      });
    } else if (before.status === 'approved' && decision !== 'approved') {
      await leaveQuota.applyLeaveChange(before, 'kembalikan', {
        actorId: req.user.id,
        reason: 'Persetujuan cuti tahunan ditarik kembali',
      });
    }

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'leave.review',
      entity: 'leave_requests',
      entityId: leaveId,
      before: { status: before.status, review_note: before.review_note },
      after: { status: row.status, review_note: req.body?.review_note || null },
      detail: {
        employee: before.employee_name,
        jenis: leaveQuota.leaveLabel(before),
        tanggal: `${row.start_date} s/d ${row.end_date}`,
        dipaksa: req.body?.force === true,
      },
    });

    // Status rekap harian ikut dihitung ulang supaya izin/cuti/dinas yang baru
    // disetujui langsung terlihat di laporan tanpa menunggu backfill.
    // Rentang selalu diurutkan: menyetujui dan mencabut persetujuan sama-sama
    // perlu menghitung ulang seluruh rentang pengajuan.
    const rangeStart = row.start_date < row.end_date ? row.start_date : row.end_date;
    const rangeEnd = row.start_date < row.end_date ? row.end_date : row.start_date;
    if (rangeStart && rangeEnd) {
      await attendance.generate({
        from: rangeStart,
        to: rangeEnd,
        employeeId: row.employee_id,
        force: true,
      });
    }

    // Notif realtime hasil review ke karyawan pengaju (khusus dinas).
    try {
      await realtime.onLeaveReviewed(
        row,
        req.user.full_name || req.user.username,
        decision
      );
    } catch {
      // abaikan
    }

    res.json({ ok: true, data: row });
  })
);

/** Daftar pengajuan yang menunggu persetujuan. */
router.get(
  '/leaves/pending',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      `SELECT lr.*, e.name AS employee_name, e.employee_code
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        WHERE lr.status = 'pending'
        ORDER BY lr.start_date ASC`
    );

    // Sisa jatah cuti tahunan dilampirkan supaya pengaju yang bisa langsung
    // melihat apakah pengajuannya masih muat tanpa membuka detail karyawan.
    const quotas = await leaveQuota.getSummaryMap(rows.map((row) => row.employee_id));
    res.json({ ok: true, data: rows.map((row) => decorateLeave(row, quotas[row.employee_id])) });
  })
);

/**
 * Riwayat pengajuan cuti/izin/dinas beserta statusnya (pending, approved,
 * rejected). Dipakai admin untuk melihat pengajuan yang sudah diputuskan.
 */
router.get(
  '/leaves/history',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const { where, params } = leaveHistoryFilter(req.query);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

    const rows = await db.queryAll(
      `SELECT lr.*, e.name AS employee_name, e.employee_code,
              u.username AS reviewer_name, u.full_name AS reviewer_full_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN app_users u ON u.id = lr.reviewed_by
        ${where}
        ORDER BY lr.created_at DESC, lr.id DESC
        LIMIT ${limit}`,
      params
    );

    const counts = await db.queryOne(
      `SELECT SUM(status = 'pending') AS pending,
              SUM(status = 'approved') AS approved,
              SUM(status = 'rejected') AS rejected
         FROM leave_requests`
    );

    res.json({
      ok: true,
      data: rows.map(decorateLeave),
      meta: {
        total: rows.length,
        counts: {
          pending: Number(counts.pending || 0),
          approved: Number(counts.approved || 0),
          rejected: Number(counts.rejected || 0),
        },
      },
    });
  })
);

function leaveHistoryFilter(query = {}) {
  const where = [];
  const params = [];
  const status = query.status ? String(query.status).trim() : '';
  if (status && status !== 'all') {
    const list = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) {
      where.push(`lr.status IN (${list.map(() => '?').join(', ')})`);
      params.push(...list);
    }
  }
  if (query.employee_id) {
    where.push('lr.employee_id = ?');
    params.push(Number(query.employee_id));
  }
  return { where: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Tambahkan label kategori/jenis/status agar frontend tidak perlu kamus sendiri. */
function decorateLeave(row, quota = null) {
  const days = Number(row.quota_days || 0);
  return {
    ...row,
    category: leaveCatalog.categoryForLeave(row.leave_type, row.subtype),
    subtype_label: leaveCatalog.findSubtype(row.subtype)?.label || null,
    status_label: statusLabel(row.status),
    date_range: row.start_date === row.end_date ? row.start_date : `${row.start_date} s/d ${row.end_date}`,
    reviewer: row.reviewer_full_name || row.reviewer_name || null,
    // Kvota cuti tahunan hanya relevan untuk sub-jenis cuti tahunan.
    uses_quota: leaveQuota.usesQuota(row),
    quota_days: days,
    leave_quota: quota,
    quota_short: quota ? days > quota.remaining : false,
  };
}

function statusLabel(status) {
  if (status === 'approved') return 'Disetujui';
  if (status === 'rejected') return 'Ditolak';
  if (status === 'pending') return 'Menunggu';
  return String(status || '-');
}

/** Daftar reimburse yang menunggu persetujuan. */
router.get(
  '/reimburses/pending',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      `SELECT r.*, e.name AS employee_name, e.employee_code
         FROM reimburses r
         JOIN employees e ON e.id = r.employee_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC`
    );
    res.json({ ok: true, data: rows.map(decorateReimburse) });
  })
);

/** Riwayat reimburse beserta statusnya. */
router.get(
  '/reimburses/history',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const where = [];
    const params = [];
    const status = req.query.status ? String(req.query.status).trim() : '';
    if (status && status !== 'all') {
      const list = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) {
        where.push(`r.status IN (${list.map(() => '?').join(', ')})`);
        params.push(...list);
      }
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

    const rows = await db.queryAll(
      `SELECT r.*, e.name AS employee_name, e.employee_code,
              u.username AS reviewer_name, u.full_name AS reviewer_full_name
         FROM reimburses r
         JOIN employees e ON e.id = r.employee_id
         LEFT JOIN app_users u ON u.id = r.reviewed_by
        ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${limit}`,
      params
    );

    const counts = await db.queryOne(
      `SELECT SUM(status = 'pending') AS pending,
              SUM(status = 'approved') AS approved,
              SUM(status = 'rejected') AS rejected
         FROM reimburses`
    );

    res.json({
      ok: true,
      data: rows.map(decorateReimburse),
      meta: {
        total: rows.length,
        counts: {
          pending: Number(counts.pending || 0),
          approved: Number(counts.approved || 0),
          rejected: Number(counts.rejected || 0),
        },
      },
    });
  })
);

function decorateReimburse(row) {
  return {
    ...row,
    status_label: statusLabel(row.status),
    reviewer: row.reviewer_full_name || row.reviewer_name || null,
    receipt_url: row.attachment ? `/api/employees/reimburses/${row.id}/receipt` : null,
  };
}

/** Ambil riwayat mentah (tanpa dekorasi label) untuk ekspor. */
async function fetchLeaveHistory(query = {}) {
  const { where, params } = leaveHistoryFilter(query);
  const limit = Math.min(2000, Math.max(1, Number(query.limit) || 1000));
  return db.queryAll(
    `SELECT lr.*, e.name AS employee_name, e.employee_code,
            u.username AS reviewer_name, u.full_name AS reviewer_full_name
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       LEFT JOIN app_users u ON u.id = lr.reviewed_by
      ${where}
      ORDER BY lr.created_at DESC, lr.id DESC
      LIMIT ${limit}`,
    params
  );
}

async function fetchReimburseHistory(query = {}) {
  const where = [];
  const params = [];
  const status = query.status ? String(query.status).trim() : '';
  if (status && status !== 'all') {
    const list = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) {
      where.push(`r.status IN (${list.map(() => '?').join(', ')})`);
      params.push(...list);
    }
  }
  const limit = Math.min(2000, Math.max(1, Number(query.limit) || 1000));
  return db.queryAll(
    `SELECT r.*, e.name AS employee_name, e.employee_code,
            u.username AS reviewer_name, u.full_name AS reviewer_full_name
       FROM reimburses r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN app_users u ON u.id = r.reviewed_by
      ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${limit}`,
    params
  );
}

/** Ekspor riwayat pengajuan (cuti/izin/dinas + reimburse) ke Excel. */
router.get(
  '/history/export/excel',
  auth.requirePermission('reports:export'),
  wrap(async (req, res) => {
    const ExcelJS = require('exceljs');
    const tab = req.query.tab === 'reimburse' ? 'reimburse' : 'leave';
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Aplikasi Absensi Fingerprint';
    workbook.created = new Date();

    if (tab === 'reimburse') {
      const rows = await fetchReimburseHistory(req.query);
      const sheet = workbook.addWorksheet('Riwayat Reimburse');
      const headers = ['Tanggal', 'Kode', 'Karyawan', 'Deskripsi', 'Jumlah (Rp)', 'Status', 'Pemeriksa', 'Diproses', 'Diajukan'];
      sheet.getRow(1).values = headers;
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => {
        sheet.addRow([
          String(r.created_at || '').slice(0, 10),
          r.employee_code,
          r.employee_name,
          r.description,
          Number(r.amount || 0),
          statusLabel(r.status),
          r.reviewer_full_name || r.reviewer_name || '',
          r.reviewed_at || '',
          r.created_at || '',
        ]);
      });
      sheet.getColumn(5).numFmt = '#,##0';
      sheet.columns.forEach((c) => { c.width = Math.max(12, Math.min(40, (c.width || 12))); });
    } else {
      const rows = await fetchLeaveHistory(req.query);
      const sheet = workbook.addWorksheet('Riwayat Pengajuan');
      sheet.getRow(1).values = ['Kode', 'Karyawan', 'Kategori', 'Jenis', 'Mulai', 'Selesai', 'Tujuan', 'Keterangan', 'Status', 'Pemeriksa', 'Diproses', 'Diajukan'];
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => {
        const dec = decorateLeave(r);
        sheet.addRow([
          r.employee_code,
          r.employee_name,
          dec.category,
          dec.subtype_label,
          r.start_date,
          r.end_date,
          r.place || '',
          r.reason || '',
          dec.status_label,
          dec.reviewer || '',
          r.reviewed_at || '',
          r.created_at || '',
        ]);
      });
      sheet.columns.forEach((c) => { c.width = Math.max(12, Math.min(40, (c.width || 12))); });
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const filename = tab === 'reimburse' ? 'riwayat-reimburse.xlsx' : 'riwayat-pengajuan.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  })
);

/**
 * Impor riwayat pengajuan dari CSV/Excel.
 * Format kolom: employee_code, subtype, start_date, end_date, place, reason
 * Baris yang karyawan/subtype-nya tidak dikenal dilewati dan dilaporkan.
 */
router.post(
  '/history/import',
  auth.requirePermission('attendance:write'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('File tidak ditemukan. Gunakan field "file".');
    const ExcelJS = require('exceljs');

    let rows = [];
    const name = String(req.file.originalname || '').toLowerCase();
    if (/\.(xlsx|xls)$/.test(name)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const sheet = wb.worksheets[0];
      sheet.eachRow((row) => {
        rows.push(row.values.slice(1).map((v) => (v == null ? '' : String(v))));
      });
    } else {
      const text = decodeUpload(req.file.buffer);
      rows = parseCsv(text, detectDelimiter(text.slice(0, 4000)));
    }
    if (rows.length < 2) throw badRequest('File tidak berisi data. Minimal header + 1 baris.');

    const header = rows[0].map((h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    const col = (names) => header.findIndex((h) => names.includes(h));
    const iCode = col(['employeecode', 'kode', 'nik', 'code']);
    const iSubtype = col(['subtype', 'jenis', 'subjenis']);
    const iStart = col(['startdate', 'mulai', 'tanggalmulai', 'from']);
    const iEnd = col(['enddate', 'selesai', 'tanggalselesai', 'to']);
    const iPlace = col(['place', 'tujuan', 'lokasi']);
    const iReason = col(['reason', 'keterangan', 'alasan']);
    const iStatus = col(['status']);
    if (iCode < 0 || iSubtype < 0 || iStart < 0) {
      throw badRequest('Header wajib: employee_code, subtype, start_date (opsional: end_date, place, reason, status).');
    }

    const empRows = await db.queryAll('SELECT id, employee_code FROM employees');
    const empByCode = new Map(empRows.map((e) => [String(e.employee_code).trim(), e.id]));
    const { toDate } = require('../utils/date');

    let inserted = 0;
    const skipped = [];
    for (let i = 1; i < rows.length; i += 1) {
      const line = rows[i];
      try {
        const code = String(line[iCode] || '').trim();
        const employeeId = empByCode.get(code);
        if (!employeeId) throw new Error(`kode "${code}" tidak dikenal`);
        const subtype = leaveCatalog.findSubtype(String(line[iSubtype] || '').trim());
        if (!subtype) throw new Error(`subtype "${line[iSubtype]}" tidak dikenal`);
        const startDate = toDate(String(line[iStart] || '').trim());
        if (!startDate) throw new Error(`start_date "${line[iStart]}" tidak valid`);
        const endDate = subtype.single_day ? startDate : toDate(String(iEnd >= 0 ? line[iEnd] || '' : '') || startDate);
        if (!endDate) throw new Error('end_date tidak valid');
        const place = iPlace >= 0 ? String(line[iPlace] || '').trim().slice(0, 150) || null : null;
        if (subtype.needs_place && !place) throw new Error(`lokasi wajib untuk ${subtype.label}`);
        const statusRaw = iStatus >= 0 ? String(line[iStatus] || '').trim().toLowerCase() : 'pending';
        const status = ['approved', 'rejected'].includes(statusRaw) ? statusRaw : 'pending';
        await db.execute(
          `INSERT INTO leave_requests
             (employee_id, leave_type, subtype, place, start_date, end_date, reason, status,
              reviewed_by, reviewed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'pending' ? 'NULL' : 'NOW()'})`,
          [
            employeeId, subtype.leave_type, subtype.key, place, startDate, endDate,
            iReason >= 0 ? String(line[iReason] || '').trim().slice(0, 500) || null : null,
            status, status === 'pending' ? null : req.user.id,
          ]
        );
        inserted += 1;
      } catch (err) {
        skipped.push({ baris: i + 1, pesan: err.message });
      }
    }

    res.json({ ok: true, data: { inserted, skipped: skipped.length, errors: skipped.slice(0, 20) } });
  })
);

const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 + 1024, files: 21 },
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      cb(badRequest('Bukti harus JPG, PNG, WEBP, atau PDF.'));
      return;
    }
    cb(null, true);
  },
});

/** Buat reimburse biaya perjalanan (admin/HR atas nama karyawan, atau karyawan via portal). */
router.post(
  '/reimburses',
  auth.requirePermission('attendance:write'),
  receiptUpload.single('receipt'),
  wrap(async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) throw badRequest('employee_id wajib diisi.');
    await employees.getOrFail(employeeId);

    const description = String(req.body?.description || '').trim().slice(0, 500);
    if (!description) throw badRequest('description wajib diisi.');
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount harus angka > 0.');

    const portal = require('../services/employeePortal');
    const row = await portal.createReimburse(
      employeeId,
      { description, amount },
      req.file || null
    );

    try {
      const emp = await employees.getOrFail(employeeId);
      await realtime.onReimburseSubmitted(row, emp.name);
    } catch {
      // abaikan
    }

    res.status(201).json({ ok: true, data: row });
  })
);

/** Unduh bukti reimburse (admin/HR/operator). */
router.get(
  '/reimburses/:id/receipt',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const row = await db.queryOne('SELECT id, attachment FROM reimburses WHERE id = ?', [
      Number(req.params.id),
    ]);
    if (!row || !row.attachment) throw notFound('Bukti tidak ditemukan.');
    const portal = require('../services/employeePortal');
    const path = require('node:path');
    const name = path.basename(String(row.attachment));
    const absolute = path.join(portal.receiptDir, name);
    if (!absolute.startsWith(portal.receiptDir + path.sep)) throw notFound('Bukti tidak ditemukan.');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(absolute);
  })
);

/** Simpan banyak reimburse sekaligus (multi-form admin). */
router.post(
  '/reimburses/batch',
  auth.requirePermission('attendance:write'),
  receiptUpload.any(),
  wrap(async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) throw badRequest('employee_id wajib diisi.');
    let items = req.body?.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        throw badRequest('items tidak valid (harus JSON array).');
      }
    }
    const filesByIndex = {};
    for (const f of req.files || []) {
      const m = /^receipts\[(\d+)\]$/.exec(f.fieldname || '');
      if (m) filesByIndex[Number(m[1])] = f;
    }
    const files = (Array.isArray(items) ? items : []).map((_, i) => filesByIndex[i] || null);
    const portal = require('../services/employeePortal');
    const rows = await portal.createReimburseBatch(employeeId, items, files);
    try {
      const emp = await employees.getOrFail(employeeId);
      for (const row of rows) {
        await realtime.onReimburseSubmitted(row, emp.name);
      }
    } catch {
      // abaikan
    }
    res.status(201).json({ ok: true, data: rows, count: rows.length });
  })
);

/** Review reimburse (approve/reject). */
router.put(
  '/reimburses/:reimburseId/review',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const decision = req.body?.status;
    if (!['approved', 'rejected'].includes(decision)) {
      throw badRequest("status harus 'approved' atau 'rejected'.");
    }

    const beforeStatus = await db.queryScalar(
      'SELECT status FROM reimburses WHERE id = ?',
      [Number(req.params.reimburseId)]
    );

    const result = await db.execute(
      'UPDATE reimburses SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
      [decision, req.user.id, Number(req.params.reimburseId)]
    );

    if (result.affectedRows === 0) throw notFound('Reimburse tidak ditemukan.');

    const row = await db.queryOne('SELECT * FROM reimburses WHERE id = ?', [
      Number(req.params.reimburseId),
    ]);

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'reimburse.review',
      entity: 'reimburses',
      entityId: row.id,
      before: { status: beforeStatus },
      after: { status: row.status, review_note: req.body?.review_note || null },
      detail: {
        employee_id: row.employee_id,
        jumlah: row.amount,
        keterangan: row.description,
      },
    });

    try {
      await realtime.onReimburseReviewed(
        row,
        req.user.full_name || req.user.username,
        decision
      );
    } catch {
      // abaikan
    }

    res.json({ ok: true, data: row });
  })
);

/** Template sidik jari milik karyawan. */
router.get(
  '/:id/fingerprints',
  auth.requirePermission('employees:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      `SELECT id, finger_index, valid, size_bytes,
              (template IS NOT NULL) AS has_template, created_at, updated_at
         FROM fingerprint_templates
        WHERE employee_id = ?
        ORDER BY finger_index`,
      [Number(req.params.id)]
    );
    res.json({ ok: true, data: rows });
  })
);

/** Daftar seluruh karyawan aktif untuk dropdown (ringkas). */
router.get(
  '/options/list',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rows = await db.queryAll(
      `SELECT e.id, e.employee_code, e.name, e.device_user_id,
              e.department_id, dep.name AS department_name
         FROM employees e
         LEFT JOIN departments dep ON dep.id = e.department_id
        WHERE e.status = 'aktif'
        ORDER BY e.name`
    );
    res.json({ ok: true, data: rows });
  })
);

function decodeUpload(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  return buffer.toString('utf8');
}

module.exports = router;
