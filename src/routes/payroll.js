'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const db = require('../db/pool');
const audit = require('../services/audit');
const payroll = require('../services/payroll');

const router = express.Router();

router.use(auth.requireAuth);

/**
 * API Payroll / Penggajian.
 *
 * - Komponen, gaji karyawan, kalkulasi: payroll:read (lihat) / payroll:write (ubah).
 * - approve, pay, reopen: payroll:approve (khusus admin, mengunci periode).
 * - Slip sendiri: self:read, dibatasi ke akun tertaut (lihat route /slip).
 */

function auditIp(req) {
  return audit.ipOf(req);
}

// ---------------------------------------------------------------------------
// Komponen gaji
// ---------------------------------------------------------------------------

router.get(
  '/components',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({
      ok: true,
      data: await payroll.listComponents({ includeInactive: req.query.include_inactive !== '0' }),
    });
  })
);

router.post(
  '/components',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const row = await payroll.createComponent(req.body || {});
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.component_create',
      entity: 'payroll_components', entityId: row.id, detail: row,
    });
    await payroll.writeAudit({ action: 'component.create', actorId: req.user.id, ip: auditIp(req), detail: { id: row.id, code: row.code } });
    res.status(201).json({ ok: true, data: row });
  })
);

router.put(
  '/components/:id',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const before = await payroll.getComponent(Number(req.params.id));
    const row = await payroll.updateComponent(Number(req.params.id), req.body || {});
    await audit.recordChange({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.component_update',
      entity: 'payroll_components', entityId: row.id, before, after: row,
    });
    await payroll.writeAudit({ action: 'component.update', actorId: req.user.id, ip: auditIp(req), detail: { id: row.id } });
    res.json({ ok: true, data: row });
  })
);

router.delete(
  '/components/:id',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const result = await payroll.removeComponent(Number(req.params.id));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.component_delete',
      entity: 'payroll_components', entityId: Number(req.params.id), detail: result,
    });
    await payroll.writeAudit({ action: 'component.delete', actorId: req.user.id, ip: auditIp(req), detail: result });
    res.json({ ok: true, ...result });
  })
);

// ---------------------------------------------------------------------------
// Gaji pokok & komponen per karyawan
// ---------------------------------------------------------------------------

router.get(
  '/employees',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const dept = req.query.department_id ? Number(req.query.department_id) : null;
    const where = ["e.status <> 'resign'"];
    const params = [];
    if (search) {
      where.push('(e.name LIKE ? OR e.employee_code LIKE ?)');
      const like = `%${search.slice(0, 100)}%`;
      params.push(like, like);
    }
    if (dept) {
      where.push('e.department_id = ?');
      params.push(dept);
    }
    const rows = await db.queryAll(
      `SELECT e.id, e.employee_code, e.name, e.status,
              dep.name AS department_name, pos.name AS position_name,
              COALESCE(s.base_salary, 0) AS base_salary,
              COALESCE(s.payroll_enabled, 1) AS payroll_enabled
         FROM employees e
         LEFT JOIN departments dep ON dep.id = e.department_id
         LEFT JOIN positions pos ON pos.id = e.position_id
         LEFT JOIN payroll_employee_salary s ON s.employee_id = e.id
        WHERE ${where.join(' AND ')}
        ORDER BY e.name ASC`,
      params
    );
    const { roundIdr } = require('../services/payrollMoney');
    res.json({
      ok: true,
      data: rows.map((r) => ({ ...r, base_salary: roundIdr(r.base_salary), payroll_enabled: Number(r.payroll_enabled) })),
    });
  })
);

router.get(
  '/employees/:id',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const emp = await db.queryOne(
      `SELECT e.id, e.employee_code, e.name, e.status,
              dep.name AS department_name, pos.name AS position_name
         FROM employees e
         LEFT JOIN departments dep ON dep.id = e.department_id
         LEFT JOIN positions pos ON pos.id = e.position_id
        WHERE e.id = ?`,
      [id]
    );
    if (!emp) throw badRequest(`Karyawan id ${id} tidak ditemukan.`);
    const [salary, overrides, components] = await Promise.all([
      payroll.getEmployeeSalary(id),
      payroll.listEmployeeComponents(id),
      payroll.effectiveComponents(id),
    ]);
    res.json({ ok: true, data: { employee: emp, salary, overrides, components } });
  })
);

router.put(
  '/employees/:id/salary',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const row = await payroll.setEmployeeSalary(Number(req.params.id), req.body || {});
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.salary_update',
      entity: 'payroll_employee_salary', entityId: Number(req.params.id), detail: row,
    });
    res.json({ ok: true, data: row });
  })
);

router.post(
  '/employees/:id/components',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const { component_id: componentId } = req.body || {};
    if (!componentId) throw badRequest('component_id wajib diisi.');
    const rows = await payroll.setEmployeeComponent(Number(req.params.id), Number(componentId), req.body || {});
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.employee_component_set',
      entity: 'payroll_employee_components', entityId: Number(req.params.id), detail: req.body || {},
    });
    res.json({ ok: true, data: rows });
  })
);

router.delete(
  '/employees/:id/components/:componentId',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const rows = await payroll.removeEmployeeComponent(Number(req.params.id), Number(req.params.componentId));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.employee_component_delete',
      entity: 'payroll_employee_components', entityId: Number(req.params.id), detail: { component_id: Number(req.params.componentId) },
    });
    res.json({ ok: true, data: rows });
  })
);

// ---------------------------------------------------------------------------
// Periode payroll
// ---------------------------------------------------------------------------

router.get(
  '/periods',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await payroll.listPeriods(req.query) });
  })
);

router.post(
  '/periods',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const period = await payroll.createPeriod({ ...(req.body || {}), created_by: req.user.id });
    await payroll.writeAudit({
      periodId: period.id, action: 'period.create', actorId: req.user.id,
      ip: auditIp(req), detail: { year: period.period_year, month: period.period_month },
    });
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_create',
      entity: 'payroll_periods', entityId: period.id, detail: period,
    });
    res.status(201).json({ ok: true, data: period });
  })
);

router.get(
  '/periods/:id',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    const period = await payroll.getPeriodOrFail(Number(req.params.id));
    const [items, summary] = await Promise.all([
      payroll.listItems(Number(req.params.id), req.query),
      payroll.periodSummary(Number(req.params.id)),
    ]);
    res.json({ ok: true, data: { period, items, summary } });
  })
);

router.delete(
  '/periods/:id',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const result = await payroll.deletePeriod(Number(req.params.id));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_delete',
      entity: 'payroll_periods', entityId: Number(req.params.id), detail: result,
    });
    res.json({ ok: true, ...result });
  })
);

/** Karyawan layak + pratinjau absensi untuk satu periode. */
router.get(
  '/periods/:id/eligible',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await payroll.eligibleEmployees(Number(req.params.id)) });
  })
);

/** Hitung/isi ulang payroll (draft saja). */
router.post(
  '/periods/:id/calc',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const result = await payroll.recalcPeriod(Number(req.params.id), {
      employeeIds: req.body?.employee_ids || req.body?.employeeIds || null,
      actorId: req.user.id,
    });
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_calc',
      entity: 'payroll_periods', entityId: Number(req.params.id), detail: result,
    });
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/periods/:id/approve',
  auth.requirePermission('payroll:approve'),
  wrap(async (req, res) => {
    const period = await payroll.approvePeriod(Number(req.params.id), req.user.id, auditIp(req));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_approve',
      entity: 'payroll_periods', entityId: period.id, detail: { status: period.status },
    });
    res.json({ ok: true, data: period, message: 'Periode disahkan dan dikunci.' });
  })
);

router.post(
  '/periods/:id/pay',
  auth.requirePermission('payroll:approve'),
  wrap(async (req, res) => {
    const period = await payroll.payPeriod(Number(req.params.id), req.user.id, auditIp(req));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_pay',
      entity: 'payroll_periods', entityId: period.id, detail: { status: period.status },
    });
    res.json({ ok: true, data: period, message: 'Periode ditandai sudah dibayar.' });
  })
);

router.post(
  '/periods/:id/reopen',
  auth.requirePermission('payroll:approve'),
  wrap(async (req, res) => {
    const period = await payroll.reopenPeriod(Number(req.params.id), req.user.id, auditIp(req));
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.period_reopen',
      entity: 'payroll_periods', entityId: period.id, detail: { status: period.status },
    });
    res.json({ ok: true, data: period, message: 'Periode dibuka kembali ke draft (tercatat di audit).' });
  })
);

router.get(
  '/periods/:id/audit',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({
      ok: true,
      data: await payroll.listAudit(Number(req.params.id), { itemId: req.query.item_id ? Number(req.query.item_id) : null }),
    });
  })
);

router.get(
  '/periods/:id/summary',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await payroll.periodSummary(Number(req.params.id)) });
  })
);

router.get(
  '/periods/:id/export/excel',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    const result = await payroll.exportExcel(Number(req.params.id));
    const buffer = Buffer.from(result.buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  })
);

router.get(
  '/periods/:id/export/csv',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    const result = await payroll.exportCsv(Number(req.params.id));
    const buffer = Buffer.from(result.buffer);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  })
);

// ---------------------------------------------------------------------------
// Item payroll
// ---------------------------------------------------------------------------

router.get(
  '/items/:id',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await payroll.getItem(Number(req.params.id)) });
  })
);

router.put(
  '/items/:id',
  auth.requirePermission('payroll:write'),
  wrap(async (req, res) => {
    const item = await payroll.correctItem(Number(req.params.id), {
      lines: (req.body || {}).lines || [],
      note: (req.body || {}).note,
    });
    await audit.record({
      userId: req.user.id, ip: auditIp(req), action: 'payroll.item_correct',
      entity: 'payroll_items', entityId: item.id, detail: { net: item.net_salary },
    });
    await payroll.writeAudit({
      periodId: item.period_id, itemId: item.id, employeeId: item.employee_id,
      action: 'item.recalc_manual', actorId: req.user.id, ip: auditIp(req),
      detail: { net: item.net_salary },
    });
    res.json({ ok: true, data: item });
  })
);

/** Data slip untuk satu item (struktur, siap render di halaman detail). */
router.get(
  '/items/:id/slip',
  auth.requirePermission('payroll:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await payroll.buildSlip(Number(req.params.id)) });
  })
);

/** Slip milik sendiri (karyawan login melihat slipnya sendiri). */
router.get(
  '/slip/:itemId',
  auth.requireAuth,
  auth.requireSelf,
  wrap(async (req, res) => {
    if (!['admin', 'hr'].includes(req.user.role)) {
      const itemId = Number(req.params.itemId);
      const slip = await payroll.getEmployeeSlip(req.employeeId, itemId);
      return res.json({ ok: true, data: slip });
    }
    // Admin/HR memanggil endpoint ini bila membawa employee_id.
    const employeeId = Number(req.query.employee_id);
    if (!employeeId) throw badRequest('employee_id wajib diisi untuk peran ini.');
    res.json({ ok: true, data: await payroll.getEmployeeSlip(employeeId, Number(req.params.itemId)) });
  })
);

/** Riwayat slip milik sendiri (daftar ringkas). */
router.get(
  '/slips/mine',
  auth.requireAuth,
  auth.requireSelf,
  wrap(async (req, res) => {
    const employeeId = await auth.resolveSelfEmployeeId(req);
    const slips = await payroll.listEmployeeSlips(employeeId, { limit: req.query.limit });
    res.json({ ok: true, data: slips });
  })
);

module.exports = router;
