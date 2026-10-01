'use strict';

const express = require('express');
const multer = require('multer');

const db = require('../db/pool');
const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest, notFound } = require('../utils/errors');
const employees = require('../services/employees');
const attendance = require('../services/attendance');
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
    res.status(201).json({ ok: true, data: employee });
  })
);

router.put(
  '/:id',
  auth.requirePermission('employees:write'),
  wrap(async (req, res) => {
    const employee = await employees.update(Number(req.params.id), req.body || {});
    res.json({ ok: true, data: employee });
  })
);

router.delete(
  '/:id',
  auth.requirePermission('employees:delete'),
  wrap(async (req, res) => {
    const result = await employees.remove(Number(req.params.id));
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
      `SELECT sc.*, s.code AS shift_code, s.name AS shift_name
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

    const { leave_type: type, start_date: start, end_date: end, reason } = req.body || {};
    const allowed = ['izin', 'sakit', 'cuti', 'izin_meninggal', 'dinas_luar'];
    if (!allowed.includes(type)) throw badRequest(`leave_type tidak valid. Pilihan: ${allowed.join(', ')}.`);

    const startDate = toDate(start);
    const endDate = toDate(end || start);
    if (!startDate || !endDate) throw badRequest('start_date / end_date tidak valid.');
    if (endDate < startDate) throw badRequest('end_date tidak boleh lebih awal dari start_date.');

    const result = await db.execute(
      'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)',
      [employeeId, type, startDate, endDate, reason || null]
    );

    const row = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [result.insertId]);
    res.status(201).json({ ok: true, data: row });
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

    const result = await db.execute(
      'UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW(), review_note = ? WHERE id = ?',
      [decision, req.user.id, req.body?.review_note || null, Number(req.params.leaveId)]
    );

    if (result.affectedRows === 0) throw notFound('Pengajuan tidak ditemukan.');

    const row = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [Number(req.params.leaveId)]);

    // Status rekap harian ikut dihitung ulang supaya izin/cuti/dinas yang baru
    // disetujui langsung terlihat di laporan tanpa menunggu backfill.
    const rangeStart = row.status === 'approved' ? row.start_date : row.end_date;
    const rangeEnd = row.status === 'approved' ? row.end_date : row.start_date;
    if (rangeStart && rangeEnd) {
      await attendance.generate({
        from: rangeStart,
        to: rangeEnd,
        employeeId: row.employee_id,
        force: true,
      });
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
    res.json({ ok: true, data: rows });
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
      `SELECT id, employee_code, name, device_user_id
         FROM employees
        WHERE status = 'aktif'
        ORDER BY name`
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
