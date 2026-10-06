'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const db = require('../db/pool');
const shifts = require('../services/shifts');
const audit = require('../services/audit');
const {
  toDate,
  dateRange,
  isWorkDay,
  parseWorkDaysStrict,
} = require('../utils/date');

const router = express.Router();

router.use(auth.requireAuth);

router.get(
  '/',
  auth.requirePermission('shifts:read'),
  wrap(async (req, res) => {
    const includeInactive = req.query.include_inactive !== '0';
    res.json({ ok: true, data: await shifts.list({ includeInactive }) });
  })
);

router.get(
  '/options',
  auth.requirePermission('shifts:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await shifts.options() });
  })
);

router.get(
  '/:id',
  auth.requirePermission('shifts:read'),
  wrap(async (req, res) => {
    const shift = await shifts.getOrFail(Number(req.params.id));

    const stats = await db.queryOne(
      `SELECT
         (SELECT COUNT(*) FROM employees WHERE shift_id = ?) AS employees,
         (SELECT COUNT(*) FROM schedules WHERE shift_id = ?) AS schedules`,
      [shift.id, shift.id]
    );

    res.json({ ok: true, data: { ...shift, usage: stats } });
  })
);

router.post(
  '/',
  auth.requirePermission('shifts:write'),
  wrap(async (req, res) => {
    const shift = await shifts.create(req.body || {});

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'shift.create',
      entity: 'shifts',
      entityId: shift.id,
      detail: shift,
    });

    res.status(201).json({ ok: true, data: shift });
  })
);

router.put(
  '/:id',
  auth.requirePermission('shifts:write'),
  wrap(async (req, res) => {
    const before = await shifts.getOrFail(Number(req.params.id));
    const shift = await shifts.update(Number(req.params.id), req.body || {});

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'shift.update',
      entity: 'shifts',
      entityId: shift.id,
      before,
      after: shift,
    });

    res.json({ ok: true, data: shift });
  })
);

router.delete(
  '/:id',
  auth.requirePermission('shifts:write'),
  wrap(async (req, res) => {
    const result = await shifts.remove(Number(req.params.id));

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'shift.delete',
      entity: 'shifts',
      entityId: result.shift.id,
      detail: {
        shift: `${result.shift.code} - ${result.shift.name}`,
        jam: `${result.shift.start_time} s/d ${result.shift.end_time}`,
      },
    });

    res.json({ ok: true, ...result });
  })
);

/** Jadwal kerja massal untuk seluruh karyawan pada satu tanggal. */
router.post(
  '/bulk-schedule',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const { date, shift_id: shiftId, department_id: departmentId, day_type: dayType } = req.body || {};

    const workDate = toDate(date);
    if (!workDate) throw badRequest('date tidak valid (format YYYY-MM-DD).');

    const where = ["status <> 'resign'"];
    const params = [];
    if (departmentId) {
      where.push('department_id = ?');
      params.push(Number(departmentId));
    }

    const employees = await db.queryAll(
      `SELECT id FROM employees WHERE ${where.join(' AND ')}`,
      params
    );

    let saved = 0;
    for (const employee of employees) {
      await db.execute(
        `INSERT INTO schedules (employee_id, work_date, shift_id, day_type, note)
         VALUES (?, ?, ?, ?, 'Jadwal massal')
         ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), day_type = VALUES(day_type), note = VALUES(note)`,
        [employee.id, workDate, shiftId ? Number(shiftId) : null, dayType || 'kerja']
      );
      saved += 1;
    }

    res.json({ ok: true, data: { date: workDate, saved } });
  })
);

/**
 * Membuat jadwal hari kerja berulang untuk seluruh karyawan selama N hari.
 *
 * `work_days` (opsional) = daftar hari kerja yang dipakai untuk SEMUA karyawan
 * pada rentang ini, ditulis sebagai "1,2,3,4,5". Bila diisi, daftar ini yang
 * menentukan hari kerja, bukan milik shift masing-masing; berguna untuk
 * perusahaan yang punya jadwal(global) yang berbeda dari shift.
 *
 * Bila `work_days` tidak diisi, tiap karyawan memakai `work_days` shift-nya
 * seperti sebelumnya. Hari Minggu tetap libur apa pun pilihannya.
 */
router.post(
  '/generate-schedule',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const { from, to, department_id: departmentId } = req.body || {};

    const startDate = toDate(from);
    const endDate = toDate(to);
    if (!startDate || !endDate) throw badRequest('from / to tidak valid.');
    if (endDate < startDate) throw badRequest('to tidak boleh lebih awal dari from.');

    const dates = dateRange(startDate, endDate);
    if (dates.length > 120) throw badRequest('Maksimal 120 hari sekaligus.');

    // Daftar hari kerja global dari form pembuatan jadwal. Dipakai bila diisi,
    // dan divalidasi ketat supaya angka 7 (Minggu) tidak bisa lolos.
    const body = req.body || {};
    const globalDays = body.work_days
      ? parseWorkDaysStrict(body.work_days, { label: 'work_days' })
      : null;

    const where = ["status <> 'resign'"];
    const params = [];
    if (departmentId) {
      where.push('department_id = ?');
      params.push(Number(departmentId));
    }

    const employees = await db.queryAll(
      `SELECT id, shift_id FROM employees WHERE ${where.join(' AND ')}`,
      params
    );

    let created = 0;
    let skipped = 0;

    for (const employee of employees) {
      const shift = employee.shift_id ? await shifts.getById(employee.shift_id) : null;

      // Tanpa jadwal global, karyawan tanpa shift dilewati karena hari kerjanya
      // tidak bisa ditentukan. Dengan jadwal global, semua karyawan ikut.
      if (!globalDays && !shift) {
        skipped += 1;
        continue;
      }
      if (!globalDays && shift && Number(shift.is_active) !== 1) {
        skipped += 1;
        continue;
      }

      for (const workDate of dates) {
        // Hari kerja global menang bila diisi; kalau tidak, pakai shift karyawan.
        const working = globalDays
          ? isWorkDay(globalDays.join(','), workDate)
          : shifts.isWorkingDay(shift, workDate);

        await db.execute(
          `INSERT INTO schedules (employee_id, work_date, shift_id, day_type)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), day_type = VALUES(day_type)`,
          [employee.id, workDate, employee.shift_id || null, working ? 'kerja' : 'libur']
        );
        created += 1;
      }
    }

    res.json({
      ok: true,
      data: {
        from: startDate,
        to: endDate,
        days: dates.length,
        employees: employees.length,
        created,
        skipped,
        // Ditampilkan di UI supaya admin tahu jadwal mana yang dipakai.
        work_days: globalDays ? globalDays.join(',') : null,
      },
    });
  })
);

module.exports = router;
