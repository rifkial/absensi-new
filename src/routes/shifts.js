'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const db = require('../db/pool');
const shifts = require('../services/shifts');
const audit = require('../services/audit');
const { toDate, dateRange } = require('../utils/date');

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

/** Membuat jadwal hari kerja berulang untuk seluruh karyawan selama N hari. */
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
      if (!employee.shift_id) {
        skipped += 1;
        continue;
      }
      const shift = await shifts.getById(employee.shift_id);
      if (!shift) {
        skipped += 1;
        continue;
      }

      for (const workDate of dates) {
        const working = shifts.isWorkingDay(shift, workDate);
        await db.execute(
          `INSERT INTO schedules (employee_id, work_date, shift_id, day_type)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), day_type = VALUES(day_type)`,
          [employee.id, workDate, employee.shift_id, working ? 'kerja' : 'libur']
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
      },
    });
  })
);

module.exports = router;
