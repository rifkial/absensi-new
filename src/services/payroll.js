'use strict';

const ExcelJS = require('exceljs');

const db = require('../db/pool');
const config = require('../config');
const settingsService = require('./settings');
const { DEFAULT_COMPONENTS } = require('./payrollDefaults');
const { computePayroll, resolveComponent, parseRule } = require('./payrollCalc');
const { roundIdr, toNumber, terbilang, formatIdr } = require('./payrollMoney');
const { badRequest, notFound, conflict, str, boolParam } = require('../utils/errors');
const { toDate, isoDayOfWeek } = require('../utils/date');

/**
 * Modul Payroll / Penggajian.
 *
 * - payroll_components            master komponen (penghasilan/potongan/beban)
 * - payroll_employee_salary       gaji pokok + status ikut payroll per karyawan
 * - payroll_employee_components   override komponen per karyawan
 * - payroll_periods               periode bulanan (draft/approved/paid)
 * - payroll_items                 hasil per karyawan (snapshot)
 * - payroll_item_lines            rincian baris per komponen
 *
 * Angka absensi TIDAK dihitung ulang: diambil apa adanya dari attendance_daily
 * yang sudah diproduksi modul absensi.
 */

const TYPES = ['penghasilan', 'potongan', 'beban_perusahaan'];
const METHODS = ['tetap', 'persen', 'manual', 'absensi', 'lembur'];
const PERCENT_BASES = ['gaji_pokok', 'bruto', 'tunjangan', 'penghasilan_netto'];

const MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

// ---------------------------------------------------------------------------
// Komponen gaji
// ---------------------------------------------------------------------------

const COMPONENT_SELECT = `
  id, code, name, type, category, calc_method, amount, percent, percent_base,
  rule_json, taxable, bpjs_base, is_active, sort_order, created_at, updated_at
`;

function mapComponent(row) {
  if (!row) return null;
  return {
    ...row,
    amount: roundIdr(row.amount),
    percent: row.percent === null ? null : toNumber(row.percent),
    rule_json: parseRule(row.rule_json),
    taxable: Number(row.taxable),
    bpjs_base: Number(row.bpjs_base),
    is_active: Number(row.is_active),
  };
}

/** Isi komponen default bila tabel masih kosong (instalasi baru/upgrade). */
async function ensureDefaultComponents() {
  const total = await db.queryScalar('SELECT COUNT(*) FROM payroll_components');
  if (Number(total) > 0) return false;

  for (const c of DEFAULT_COMPONENTS) {
    await db.execute(
      `INSERT INTO payroll_components
         (code, name, type, category, calc_method, amount, percent, percent_base, rule_json, taxable, bpjs_base, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE code = code`,
      [
        c.code, c.name, c.type, c.category, c.calc_method, c.amount, c.percent,
        c.percent_base, c.rule_json, c.taxable, c.bpjs_base, c.is_active, c.sort_order,
      ]
    );
  }
  return true;
}

async function listComponents({ includeInactive = true } = {}) {
  await ensureDefaultComponents();
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = await db.queryAll(
    `SELECT ${COMPONENT_SELECT} FROM payroll_components ${where} ORDER BY sort_order ASC, name ASC`
  );
  return rows.map(mapComponent);
}

async function getComponent(id) {
  const row = await db.queryOne(`SELECT ${COMPONENT_SELECT} FROM payroll_components WHERE id = ?`, [id]);
  return mapComponent(row);
}

function normalizeComponent(payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.code !== undefined) {
    const code = str(payload.code, { maxLength: 30 });
    if (!code) throw badRequest('code komponen wajib diisi.');
    data.code = code.toUpperCase().replace(/\s+/g, '_');
  }
  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 100 });
    if (!name) throw badRequest('name komponen wajib diisi.');
    data.name = name;
  }
  if (payload.type !== undefined) {
    if (!TYPES.includes(payload.type)) throw badRequest(`type harus salah satu: ${TYPES.join(', ')}.`);
    data.type = payload.type;
  }
  if (payload.category !== undefined) {
    data.category = str(payload.category, { maxLength: 40 }) || 'lainnya';
  }
  if (payload.calc_method !== undefined) {
    if (!METHODS.includes(payload.calc_method)) throw badRequest(`calc_method harus salah satu: ${METHODS.join(', ')}.`);
    data.calc_method = payload.calc_method;
  }
  if (payload.amount !== undefined) {
    const amount = roundIdr(payload.amount);
    if (amount < 0) throw badRequest('amount tidak boleh negatif.');
    data.amount = amount;
  }
  if (payload.percent !== undefined) {
    if (payload.percent === null || payload.percent === '') data.percent = null;
    else {
      const p = toNumber(payload.percent);
      if (p < 0 || p > 100) throw badRequest('percent harus 0-100.');
      data.percent = p;
    }
  }
  if (payload.percent_base !== undefined) {
    if (!payload.percent_base) data.percent_base = null;
    else if (!PERCENT_BASES.includes(payload.percent_base)) throw badRequest(`percent_base harus salah satu: ${PERCENT_BASES.join(', ')}.`);
    else data.percent_base = payload.percent_base;
  }
  if (payload.rule_json !== undefined) {
    const rule = payload.rule_json || null;
    data.rule_json = rule ? JSON.stringify(rule) : null;
  }
  if (payload.taxable !== undefined) {
    const b = boolParam(payload.taxable);
    data.taxable = b === null ? 0 : b ? 1 : 0;
  }
  if (payload.bpjs_base !== undefined) {
    const b = boolParam(payload.bpjs_base);
    data.bpjs_base = b === null ? 0 : b ? 1 : 0;
  }
  if (payload.is_active !== undefined) {
    const b = boolParam(payload.is_active);
    data.is_active = b === null ? 1 : b ? 1 : 0;
  }
  if (payload.sort_order !== undefined) {
    data.sort_order = Number.isInteger(Number(payload.sort_order)) ? Number(payload.sort_order) : 100;
  }

  return data;
}

async function createComponent(payload) {
  const data = normalizeComponent(payload);
  const existing = await db.queryOne('SELECT id FROM payroll_components WHERE code = ?', [data.code]);
  if (existing) throw conflict(`Kode komponen "${data.code}" sudah dipakai.`);

  const columns = Object.keys(data);
  const result = await db.execute(
    `INSERT INTO payroll_components (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => data[c])
  );
  return getComponent(result.insertId);
}

async function updateComponent(id, payload) {
  const current = await getComponent(id);
  if (!current) throw notFound('Komponen tidak ditemukan.');
  const data = normalizeComponent(payload, { partial: true });
  if (Object.keys(data).length === 0) throw badRequest('Tidak ada field yang diubah.');

  if (data.code) {
    const dup = await db.queryOne('SELECT id FROM payroll_components WHERE code = ? AND id <> ?', [data.code, id]);
    if (dup) throw conflict(`Kode komponen "${data.code}" sudah dipakai.`);
  }

  const columns = Object.keys(data);
  await db.execute(
    `UPDATE payroll_components SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => data[c]), id]
  );
  return getComponent(id);
}

async function removeComponent(id) {
  const current = await getComponent(id);
  if (!current) throw notFound('Komponen tidak ditemukan.');

  const used = await db.queryScalar('SELECT COUNT(*) FROM payroll_item_lines WHERE component_id = ?', [id]);
  if (Number(used) > 0) {
    // Jangan hapus komponen yang sudah pernah dipakai slip: nonaktifkan saja.
    await db.execute('UPDATE payroll_components SET is_active = 0 WHERE id = ?', [id]);
    return { deleted: false, deactivated: true, component: await getComponent(id) };
  }

  await db.execute('DELETE FROM payroll_components WHERE id = ?', [id]);
  return { deleted: true, component: current };
}

// ---------------------------------------------------------------------------
// Gaji pokok & komponen per karyawan
// ---------------------------------------------------------------------------

async function getEmployeeSalary(employeeId) {
  const row = await db.queryOne(
    `SELECT s.*, e.employee_code, e.name AS employee_name, e.status AS employee_status,
            dep.name AS department_name, pos.name AS position_name
       FROM payroll_employee_salary s
       JOIN employees e ON e.id = s.employee_id
       LEFT JOIN departments dep ON dep.id = e.department_id
       LEFT JOIN positions pos ON pos.id = e.position_id
      WHERE s.employee_id = ?`,
    [employeeId]
  );
  if (!row) return null;
  return { ...row, base_salary: roundIdr(row.base_salary), payroll_enabled: Number(row.payroll_enabled) };
}

async function ensureEmployeeRow(employeeId) {
  const emp = await db.queryOne('SELECT id FROM employees WHERE id = ?', [employeeId]);
  if (!emp) throw notFound(`Karyawan id ${employeeId} tidak ditemukan.`);
  await db.execute(
    `INSERT INTO payroll_employee_salary (employee_id, base_salary) VALUES (?, 0)
     ON DUPLICATE KEY UPDATE employee_id = employee_id`,
    [employeeId]
  );
}

async function setEmployeeSalary(employeeId, payload = {}) {
  await ensureEmployeeRow(employeeId);

  const data = [];
  const params = [];
  if (payload.base_salary !== undefined) {
    const v = roundIdr(payload.base_salary);
    if (v < 0) throw badRequest('base_salary tidak boleh negatif.');
    data.push('base_salary = ?');
    params.push(v);
  }
  if (payload.payroll_enabled !== undefined) {
    const b = boolParam(payload.payroll_enabled);
    data.push('payroll_enabled = ?');
    params.push(b === null ? 1 : b ? 1 : 0);
  }
  if (payload.effective_date !== undefined) {
    data.push('effective_date = ?');
    params.push(payload.effective_date ? toDate(payload.effective_date) : null);
  }
  if (payload.note !== undefined) {
    data.push('note = ?');
    params.push(str(payload.note, { maxLength: 255 }) || null);
  }
  if (data.length === 0) throw badRequest('Tidak ada field yang diubah.');

  params.push(employeeId);
  await db.execute(`UPDATE payroll_employee_salary SET ${data.join(', ')} WHERE employee_id = ?`, params);
  return getEmployeeSalary(employeeId);
}

async function listEmployeeComponents(employeeId) {
  const rows = await db.queryAll(
    `SELECT ec.id, ec.employee_id, ec.component_id, ec.amount, ec.percent, ec.is_active, ec.rule_json,
            c.code, c.name, c.type, c.category, c.calc_method, c.percent_base, c.sort_order
       FROM payroll_employee_components ec
       JOIN payroll_components c ON c.id = ec.component_id
      WHERE ec.employee_id = ?
      ORDER BY c.sort_order ASC, c.name ASC`,
    [employeeId]
  );
  return rows.map((r) => ({
    ...r,
    amount: r.amount === null ? null : roundIdr(r.amount),
    percent: r.percent === null ? null : toNumber(r.percent),
    is_active: r.is_active === null ? null : Number(r.is_active),
    rule_json: parseRule(r.rule_json),
  }));
}

async function setEmployeeComponent(employeeId, componentId, payload = {}) {
  await ensureEmployeeRow(employeeId);
  const component = await getComponent(componentId);
  if (!component) throw notFound('Komponen tidak ditemukan.');

  const amount = payload.amount === undefined || payload.amount === null || payload.amount === ''
    ? null : roundIdr(payload.amount);
  const percent = payload.percent === undefined || payload.percent === null || payload.percent === ''
    ? null : toNumber(payload.percent);
  const isActive = payload.is_active === undefined ? null : (boolParam(payload.is_active) ? 1 : 0);
  const ruleJson = payload.rule_json === undefined ? null : (payload.rule_json ? JSON.stringify(payload.rule_json) : null);

  await db.execute(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, percent, is_active, rule_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), percent = VALUES(percent),
       is_active = VALUES(is_active), rule_json = VALUES(rule_json)`,
    [employeeId, componentId, amount, percent, isActive, ruleJson]
  );
  return listEmployeeComponents(employeeId);
}

async function removeEmployeeComponent(employeeId, componentId) {
  await db.execute(
    'DELETE FROM payroll_employee_components WHERE employee_id = ? AND component_id = ?',
    [employeeId, componentId]
  );
  return listEmployeeComponents(employeeId);
}

/** Komponen efektif seorang karyawan (master + override), hanya yang aktif. */
async function effectiveComponents(employeeId) {
  const masters = await listComponents({ includeInactive: true });
  const overrides = await listEmployeeComponents(employeeId);
  const byId = new Map(overrides.map((o) => [o.component_id, o]));

  const result = [];
  for (const master of masters) {
    const merged = resolveComponent(master, byId.get(master.id));
    if (Number(merged.is_active) !== 1) continue;
    result.push(merged);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Data absensi (ambil apa adanya dari attendance_daily)
// ---------------------------------------------------------------------------

async function attendanceSummary(employeeId, from, to) {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) AS total_days,
       SUM(status <> 'hari_libur') AS days_work,
       SUM(status IN ('hadir','telat','dinas_luar','dinas_dalam')) AS days_present,
       SUM(status = 'telat') AS days_late,
       SUM(status = 'alpa') AS days_absent,
       SUM(status = 'izin') AS days_izin,
       SUM(status = 'sakit') AS days_sick,
       SUM(status = 'cuti') AS days_cuti,
       COALESCE(SUM(late_minutes), 0) AS late_minutes,
       COALESCE(SUM(overtime_minutes), 0) AS overtime_minutes
     FROM attendance_daily
     WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
    [employeeId, from, to]
  );

  const izin = Number(row?.days_izin || 0);
  const sick = Number(row?.days_sick || 0);
  const cuti = Number(row?.days_cuti || 0);
  return {
    daysWork: Number(row?.days_work || 0),
    daysPresent: Number(row?.days_present || 0),
    daysLate: Number(row?.days_late || 0),
    daysAbsent: Number(row?.days_absent || 0),
    daysLeave: izin + sick + cuti,
    daysSick: sick,
    daysCutoff: cuti,
    lateMinutes: Number(row?.late_minutes || 0),
    overtimeMinutes: Number(row?.overtime_minutes || 0),
  };
}

// ---------------------------------------------------------------------------
// Periode payroll
// ---------------------------------------------------------------------------

function periodRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Tahun periode tidak valid.');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Bulan periode harus 1-12.');
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function periodLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

async function listPeriods(query = {}) {
  const where = [];
  const params = [];
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.year) {
    where.push('period_year = ?');
    params.push(Number(query.year));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await db.queryAll(
    `SELECT p.*,
            (SELECT COUNT(*) FROM payroll_items i WHERE i.period_id = p.id) AS total_items,
            (SELECT COALESCE(SUM(i.net_salary),0) FROM payroll_items i WHERE i.period_id = p.id) AS total_net,
            (SELECT COALESCE(SUM(i.total_earning),0) FROM payroll_items i WHERE i.period_id = p.id) AS total_earning,
            (SELECT COALESCE(SUM(i.total_deduction),0) FROM payroll_items i WHERE i.period_id = p.id) AS total_deduction
       FROM payroll_periods p
       ${whereSql}
      ORDER BY p.period_year DESC, p.period_month DESC`,
    params
  );
  return rows.map((r) => ({
    ...r,
    total_net: roundIdr(r.total_net),
    total_earning: roundIdr(r.total_earning),
    total_deduction: roundIdr(r.total_deduction),
  }));
}

async function getPeriod(id) {
  const row = await db.queryOne('SELECT * FROM payroll_periods WHERE id = ?', [id]);
  return row || null;
}

async function getPeriodOrFail(id) {
  const row = await getPeriod(id);
  if (!row) throw notFound(`Periode payroll id ${id} tidak ditemukan.`);
  return row;
}

async function createPeriod(payload = {}) {
  const year = Number(payload.period_year ?? payload.year);
  const month = Number(payload.period_month ?? payload.month);
  const { start, end } = periodRange(year, month);

  const existing = await db.queryOne(
    'SELECT id FROM payroll_periods WHERE period_year = ? AND period_month = ?',
    [year, month]
  );
  if (existing) throw conflict(`Periode ${periodLabel(year, month)} sudah ada.`);

  const result = await db.execute(
    `INSERT INTO payroll_periods (period_year, period_month, label, start_date, end_date, note, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [year, month, str(payload.label, { maxLength: 60 }) || periodLabel(year, month), start, end,
      str(payload.note, { maxLength: 500 }) || null, payload.created_by || null]
  );
  return getPeriod(result.insertId);
}

async function deletePeriod(id) {
  const period = await getPeriodOrFail(id);
  if (period.status !== 'draft') throw conflict('Hanya periode draft yang bisa dihapus.');
  await db.execute('DELETE FROM payroll_periods WHERE id = ?', [id]);
  return { deleted: true, period };
}

// ---------------------------------------------------------------------------
// Perhitungan payroll
// ---------------------------------------------------------------------------

function mapItem(row) {
  if (!row) return null;
  return {
    ...row,
    base_salary: roundIdr(row.base_salary),
    total_earning: roundIdr(row.total_earning),
    total_deduction: roundIdr(row.total_deduction),
    total_company: roundIdr(row.total_company),
    net_salary: roundIdr(row.net_salary),
    taxable_base: roundIdr(row.taxable_base),
    bpjs_base: roundIdr(row.bpjs_base),
  };
}

function mapLine(row) {
  return {
    ...row,
    base_amount: roundIdr(row.base_amount),
    amount: roundIdr(row.amount),
    percent: row.percent === null ? null : toNumber(row.percent),
  };
}

/**
 * Hitung/isi ulang item payroll untuk daftar karyawan pada satu periode.
 * Hanya boleh saat periode draft. Bila employeeIds kosong, pakai semua
 * karyawan yang payroll_enabled = 1 dan belum resign pada rentang periode.
 */
async function recalcPeriod(periodId, { employeeIds = null, actorId = null } = {}) {
  const period = await getPeriodOrFail(periodId);
  if (period.status !== 'draft') {
    throw conflict('Periode sudah disahkan/dibayar. Buat periode koreksi atau buka kunci terlebih dahulu.');
  }

  let employees;
  if (Array.isArray(employeeIds) && employeeIds.length > 0) {
    const ids = employeeIds.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
    if (ids.length === 0) throw badRequest('employee_ids tidak valid.');
    employees = await db.queryAll(
      `SELECT e.id, e.employee_code, e.name, e.status, e.hire_date,
              dep.name AS department_name, pos.name AS position_name,
              COALESCE(s.base_salary, 0) AS base_salary
         FROM employees e
         LEFT JOIN departments dep ON dep.id = e.department_id
         LEFT JOIN positions pos ON pos.id = e.position_id
         LEFT JOIN payroll_employee_salary s ON s.employee_id = e.id
        WHERE e.id IN (${ids.map(() => '?').join(', ')}) AND e.status <> 'resign'`,
      ids
    );
  } else {
    employees = await db.queryAll(
      `SELECT e.id, e.employee_code, e.name, e.status, e.hire_date,
              dep.name AS department_name, pos.name AS position_name,
              COALESCE(s.base_salary, 0) AS base_salary
         FROM employees e
         LEFT JOIN departments dep ON dep.id = e.department_id
         LEFT JOIN positions pos ON pos.id = e.position_id
         LEFT JOIN payroll_employee_salary s ON s.employee_id = e.id
        WHERE e.status <> 'resign'
          AND COALESCE(s.payroll_enabled, 1) = 1
          AND (e.hire_date IS NULL OR e.hire_date <= ?)`,
      [period.end_date]
    );
  }

  if (employees.length === 0) {
    return { period_id: Number(periodId), calculated: 0, message: 'Tidak ada karyawan yang dihitung.' };
  }

  let count = 0;
  for (const emp of employees) {
    const attendance = await attendanceSummary(emp.id, period.start_date, period.end_date);
    const components = await effectiveComponents(emp.id);
    const { lines, totals } = computePayroll({
      baseSalary: toNumber(emp.base_salary),
      components,
      attendance,
    });

    const itemResult = await db.execute(
      `INSERT INTO payroll_items
         (period_id, employee_id, employee_code, employee_name, department_name, position_name,
          status, base_salary, total_earning, total_deduction, total_company, net_salary,
          taxable_base, bpjs_base, days_work, days_present, days_late, days_absent, days_leave,
          late_minutes, overtime_minutes, generated_at, calculated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)
       ON DUPLICATE KEY UPDATE
         employee_code = VALUES(employee_code), employee_name = VALUES(employee_name),
         department_name = VALUES(department_name), position_name = VALUES(position_name),
         status = VALUES(status), base_salary = VALUES(base_salary),
         total_earning = VALUES(total_earning), total_deduction = VALUES(total_deduction),
         total_company = VALUES(total_company), net_salary = VALUES(net_salary),
         taxable_base = VALUES(taxable_base), bpjs_base = VALUES(bpjs_base),
         days_work = VALUES(days_work), days_present = VALUES(days_present),
         days_late = VALUES(days_late), days_absent = VALUES(days_absent),
         days_leave = VALUES(days_leave), late_minutes = VALUES(late_minutes),
         overtime_minutes = VALUES(overtime_minutes), generated_at = NOW(),
         calculated_by = VALUES(calculated_by)`,
      [
        Number(periodId), emp.id, emp.employee_code, emp.name, emp.department_name, emp.position_name,
        'draft', totals.baseSalary, totals.totalEarning, totals.totalDeduction, totals.totalCompany,
        totals.netSalary, totals.taxableBase, totals.bpjsBase,
        attendance.daysWork, attendance.daysPresent, attendance.daysLate, attendance.daysAbsent,
        attendance.daysLeave, attendance.lateMinutes, attendance.overtimeMinutes, actorId || null,
      ]
    );

    const itemId = itemResult.insertId || (await db.queryScalar(
      'SELECT id FROM payroll_items WHERE period_id = ? AND employee_id = ?', [Number(periodId), emp.id]
    ));

    await db.execute('DELETE FROM payroll_item_lines WHERE item_id = ?', [itemId]);
    for (const line of lines) {
      await db.execute(
        `INSERT INTO payroll_item_lines
           (item_id, component_id, component_code, component_name, type, calc_method,
            base_amount, percent, amount, taxable, bpjs_base, detail, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          itemId, line.component_id, line.component_code, line.component_name, line.type,
          line.calc_method, line.base_amount, line.percent, line.amount,
          line.taxable || 0, line.bpjs_base || 0, line.detail, line.sort_order,
        ]
      );
    }
    count += 1;
  }

  await writeAudit({
    periodId: Number(periodId), action: 'item.calc', actorId,
    detail: { calculated: count, source: Array.isArray(employeeIds) ? 'manual' : 'massal' },
  });

  return { period_id: Number(periodId), calculated: count };
}

async function listItems(periodId, query = {}) {
  const where = ['period_id = ?'];
  const params = [Number(periodId)];
  if (query.search) {
    const like = `%${String(query.search).slice(0, 100)}%`;
    where.push('(employee_name LIKE ? OR employee_code LIKE ?)');
    params.push(like, like);
  }
  if (query.status) {
    where.push('status = ?');
    params.push(query.status);
  }
  const rows = await db.queryAll(
    `SELECT * FROM payroll_items WHERE ${where.join(' AND ')} ORDER BY employee_name ASC`,
    params
  );
  return rows.map(mapItem);
}

async function getItem(itemId) {
  const row = await db.queryOne('SELECT * FROM payroll_items WHERE id = ?', [itemId]);
  if (!row) return null;
  const lines = await db.queryAll(
    'SELECT * FROM payroll_item_lines WHERE item_id = ? ORDER BY sort_order ASC, id ASC',
    [itemId]
  );
  return { ...mapItem(row), lines: lines.map(mapLine) };
}

async function getItemOrFail(itemId) {
  const item = await getItem(itemId);
  if (!item) throw notFound(`Item payroll id ${itemId} tidak ditemukan.`);
  return item;
}

/** Koreksi manual: perbarui beberapa baris item lalu hitung ulang total. */
async function correctItem(itemId, { lines = [], note } = {}) {
  const item = await getItemOrFail(itemId);
  const period = await getPeriodOrFail(item.period_id);
  if (period.status !== 'draft') throw conflict('Periode sudah disahkan/dibayar sehingga tidak bisa dikoreksi.');

  if (lines.length > 0) {
    for (const patch of lines) {
      if (!patch.id) throw badRequest('Setiap baris koreksi wajib menyertakan id.');
      const amount = roundIdr(patch.amount);
      await db.execute(
        `UPDATE payroll_item_lines SET amount = ?, detail = ?
          WHERE id = ? AND item_id = ?`,
        [amount, patch.detail !== undefined ? str(patch.detail, { maxLength: 255 }) : null, Number(patch.id), itemId]
      );
    }
  }

  const updatedLines = await db.queryAll(
    'SELECT * FROM payroll_item_lines WHERE item_id = ? ORDER BY sort_order ASC, id ASC',
    [itemId]
  );
  const totalEarning = updatedLines.filter((l) => l.type === 'penghasilan').reduce((s, l) => s + roundIdr(l.amount), 0);
  const totalDeduction = updatedLines.filter((l) => l.type === 'potongan').reduce((s, l) => s + roundIdr(l.amount), 0);
  const totalCompany = updatedLines.filter((l) => l.type === 'beban_perusahaan').reduce((s, l) => s + roundIdr(l.amount), 0);
  const taxableBase = updatedLines
    .filter((l) => l.type === 'penghasilan' && Number(l.taxable))
    .reduce((s, l) => s + roundIdr(l.amount), 0);
  const bpjsBase = updatedLines
    .filter((l) => l.type === 'penghasilan' && Number(l.bpjs_base))
    .reduce((s, l) => s + roundIdr(l.amount), 0);
  const netSalary = totalEarning - totalDeduction;

  await db.execute(
    `UPDATE payroll_items
        SET total_earning = ?, total_deduction = ?, total_company = ?, net_salary = ?,
            taxable_base = ?, bpjs_base = ?, note = COALESCE(?, note)
      WHERE id = ?`,
    [totalEarning, totalDeduction, totalCompany, netSalary, taxableBase, bpjsBase,
      note !== undefined ? (str(note, { maxLength: 500 }) || null) : null, itemId]
  );

  await writeAudit({ periodId: item.period_id, itemId, employeeId: item.employee_id, action: 'item.edit', detail: { lines: lines.length } });
  return getItem(itemId);
}

// ---------------------------------------------------------------------------
// Persetujuan & pembayaran (mengunci periode)
// ---------------------------------------------------------------------------

async function approvePeriod(periodId, actorId, ip = null) {
  const period = await getPeriodOrFail(periodId);
  if (period.status !== 'draft') throw conflict('Periode sudah disahkan/dibayar.');

  const total = await db.queryScalar('SELECT COUNT(*) FROM payroll_items WHERE period_id = ?', [periodId]);
  if (Number(total) === 0) throw badRequest('Belum ada item payroll. Hitung payroll terlebih dahulu.');

  await db.execute(
    `UPDATE payroll_periods SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
    [actorId || null, periodId]
  );
  await db.execute(`UPDATE payroll_items SET status = 'approved' WHERE period_id = ?`, [periodId]);
  await writeAudit({ periodId, action: 'period.approve', actorId, ip, detail: { items: Number(total) } });
  return getPeriod(periodId);
}

async function payPeriod(periodId, actorId, ip = null) {
  const period = await getPeriodOrFail(periodId);
  if (period.status !== 'approved') throw conflict('Periode harus disahkan (approved) sebelum ditandai dibayar.');

  await db.execute(
    `UPDATE payroll_periods SET status = 'paid', paid_at = NOW() WHERE id = ?`,
    [periodId]
  );
  await db.execute(`UPDATE payroll_items SET status = 'paid' WHERE period_id = ?`, [periodId]);
  await writeAudit({ periodId, action: 'period.pay', actorId, ip });
  return getPeriod(periodId);
}

/** Buka kunci periode kembali ke draft (khusus admin) dengan catatan audit. */
async function reopenPeriod(periodId, actorId, ip = null) {
  const period = await getPeriodOrFail(periodId);
  if (period.status === 'draft') return period;
  await db.execute(
    `UPDATE payroll_periods SET status = 'draft', approved_by = NULL, approved_at = NULL, paid_at = NULL WHERE id = ?`,
    [periodId]
  );
  await db.execute(`UPDATE payroll_items SET status = 'draft' WHERE period_id = ?`, [periodId]);
  await writeAudit({ periodId, action: 'period.reopen', actorId, ip });
  return getPeriod(periodId);
}

// ---------------------------------------------------------------------------
// Ringkasan & slip
// ---------------------------------------------------------------------------

async function periodSummary(periodId) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS employees,
            COALESCE(SUM(total_earning),0) AS total_earning,
            COALESCE(SUM(total_deduction),0) AS total_deduction,
            COALESCE(SUM(total_company),0) AS total_company,
            COALESCE(SUM(net_salary),0) AS total_net
       FROM payroll_items WHERE period_id = ?`,
    [periodId]
  );
  return {
    employees: Number(row?.employees || 0),
    total_earning: roundIdr(row?.total_earning),
    total_deduction: roundIdr(row?.total_deduction),
    total_company: roundIdr(row?.total_company),
    total_net: roundIdr(row?.total_net),
  };
}

async function buildSlip(itemId) {
  const item = await getItemOrFail(itemId);
  const period = await getPeriodOrFail(item.period_id);
  const settings = await settingsService.getAll();

  const employee = await db.queryOne(
    `SELECT e.employee_code, e.name, e.status, e.status_karyawan,
            dep.name AS department_name, pos.name AS position_name
       FROM employees e
       LEFT JOIN departments dep ON dep.id = e.department_id
       LEFT JOIN positions pos ON pos.id = e.position_id
      WHERE e.id = ?`,
    [item.employee_id]
  );

  const statusLabels = { aktif: 'Aktif', nonaktif: 'Nonaktif', resign: 'Resign' };
  const employeeTypeLabels = {
    tetap: 'Karyawan Tetap',
    kontrak: 'Karyawan Kontrak (PKWT)',
    harian_lepas: 'Karyawan Harian Lepas',
    magang: 'Karyawan Magang',
  };

  let approver = null;
  if (period.approved_by) {
    approver = await db.queryOne('SELECT full_name FROM app_users WHERE id = ?', [period.approved_by]);
  }

  return {
    company: {
      name: settings.company_name || 'Perusahaan',
      app_name: settings.app_name || 'Aplikasi Absensi',
    },
    period: {
      id: period.id,
      label: period.label || periodLabel(period.period_year, period.period_month),
      start_date: period.start_date,
      end_date: period.end_date,
      status: period.status,
      approved_at: period.approved_at,
    },
    approval: {
      approved_by_name: approver?.full_name || null,
      approved_at: period.approved_at || null,
      paid_at: period.paid_at || null,
    },
    employee: {
      employee_code: employee?.employee_code || item.employee_code,
      name: employee?.name || item.employee_name,
      department_name: employee?.department_name || item.department_name,
      position_name: employee?.position_name || item.position_name,
      status: employee?.status || 'aktif',
      status_label: statusLabels[employee?.status] || 'Aktif',
      status_karyawan: employee?.status_karyawan || 'tetap',
      status_karyawan_label: employeeTypeLabels[employee?.status_karyawan] || employeeTypeLabels.tetap,
    },
    attendance: {
      days_work: item.days_work,
      days_present: item.days_present,
      days_late: item.days_late,
      days_absent: item.days_absent,
      days_leave: item.days_leave,
      late_minutes: item.late_minutes,
      overtime_minutes: item.overtime_minutes,
    },
    earnings: item.lines.filter((l) => l.type === 'penghasilan'),
    deductions: item.lines.filter((l) => l.type === 'potongan'),
    company_costs: item.lines.filter((l) => l.type === 'beban_perusahaan'),
    totals: {
      base_salary: item.base_salary,
      total_earning: item.total_earning,
      total_deduction: item.total_deduction,
      total_company: item.total_company,
      net_salary: item.net_salary,
    },
    net_words: terbilang(item.net_salary),
    generated_at: item.generated_at,
  };
}

// ---------------------------------------------------------------------------
// Riwayat / audit
// ---------------------------------------------------------------------------

async function writeAudit({ periodId = null, itemId = null, employeeId = null, action, detail = null, actorId = null, ip = null }) {
  try {
    await db.execute(
      `INSERT INTO payroll_audit (period_id, item_id, employee_id, action, detail, actor_id, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [periodId, itemId, employeeId, String(action).slice(0, 40),
        detail ? JSON.stringify(detail).slice(0, 4000) : null, actorId || null, ip || null]
    );
  } catch (err) {
    console.error('[payroll] Gagal menulis audit:', err.message);
  }
}

async function listAudit(periodId, { itemId = null } = {}) {
  const where = ['a.period_id = ?'];
  const params = [Number(periodId)];
  if (itemId) {
    where.push('a.item_id = ?');
    params.push(Number(itemId));
  }
  const rows = await db.queryAll(
    `SELECT a.*, u.username, u.full_name AS actor_name
       FROM payroll_audit a
       LEFT JOIN app_users u ON u.id = a.actor_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.id DESC LIMIT 200`,
    params
  );
  return rows.map((r) => ({ ...r, detail: r.detail ? safeJson(r.detail) : null }));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Riwayat slip milik satu karyawan (untuk portal & halaman karyawan). */
async function listEmployeeSlips(employeeId, { limit = 24 } = {}) {
  const rows = await db.queryAll(
    `SELECT i.id, i.period_id, i.net_salary, i.total_earning, i.total_deduction, i.status,
            p.label, p.period_year, p.period_month, p.start_date, p.end_date
       FROM payroll_items i
       JOIN payroll_periods p ON p.id = i.period_id
      WHERE i.employee_id = ?
      ORDER BY p.period_year DESC, p.period_month DESC
      LIMIT ?`,
    [employeeId, Math.min(120, Math.max(1, Number(limit) || 24))]
  );
  return rows.map((r) => ({ ...r, net_salary: roundIdr(r.net_salary), total_earning: roundIdr(r.total_earning), total_deduction: roundIdr(r.total_deduction) }));
}

async function getEmployeeSlip(employeeId, itemId) {
  const item = await db.queryOne('SELECT id, employee_id FROM payroll_items WHERE id = ?', [itemId]);
  if (!item || Number(item.employee_id) !== Number(employeeId)) throw notFound('Slip tidak ditemukan.');
  return buildSlip(itemId);
}

// ---------------------------------------------------------------------------
// Ekspor
// ---------------------------------------------------------------------------

async function exportRows(periodId) {
  const items = await listItems(periodId);
  return items.map((i) => ({
    employee_code: i.employee_code,
    employee_name: i.employee_name,
    department_name: i.department_name || '-',
    position_name: i.position_name || '-',
    days_work: i.days_work,
    days_present: i.days_present,
    days_late: i.days_late,
    days_absent: i.days_absent,
    days_leave: i.days_leave,
    overtime_minutes: i.overtime_minutes,
    base_salary: i.base_salary,
    total_earning: i.total_earning,
    total_deduction: i.total_deduction,
    total_company: i.total_company,
    net_salary: i.net_salary,
    status: i.status,
  }));
}

const EXPORT_COLUMNS = [
  { key: 'employee_code', header: 'NIK', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Unit Kerja', width: 20 },
  { key: 'position_name', header: 'Jabatan', width: 18 },
  { key: 'days_work', header: 'Hari Kerja', width: 11 },
  { key: 'days_present', header: 'Hadir', width: 9 },
  { key: 'days_late', header: 'Terlambat', width: 11 },
  { key: 'days_absent', header: 'Alpa', width: 9 },
  { key: 'days_leave', header: 'Izin/Sakit/Cuti', width: 15 },
  { key: 'overtime_minutes', header: 'Lembur (menit)', width: 14 },
  { key: 'base_salary', header: 'Gaji Pokok', width: 15 },
  { key: 'total_earning', header: 'Total Penghasilan', width: 17 },
  { key: 'total_deduction', header: 'Total Potongan', width: 16 },
  { key: 'total_company', header: 'Beban Perusahaan', width: 18 },
  { key: 'net_salary', header: 'Gaji Bersih', width: 15 },
  { key: 'status', header: 'Status', width: 11 },
];

async function exportExcel(periodId) {
  const period = await getPeriodOrFail(periodId);
  const rows = await exportRows(periodId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Aplikasi Absensi Fingerprint';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Payroll');
  sheet.mergeCells(1, 1, 1, EXPORT_COLUMNS.length);
  const title = sheet.getCell(1, 1);
  title.value = `REKAP PAYROLL - ${period.label || periodLabel(period.period_year, period.period_month)}`;
  title.font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  sheet.getRow(1).height = 24;

  const header = sheet.getRow(3);
  EXPORT_COLUMNS.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    sheet.getColumn(i + 1).width = col.width || 15;
  });

  rows.forEach((row, r) => {
    const excelRow = sheet.getRow(4 + r);
    EXPORT_COLUMNS.forEach((col, c) => {
      excelRow.getCell(c + 1).value = row[col.key] ?? '';
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer,
    filename: `payroll-${period.period_year}-${String(period.period_month).padStart(2, '0')}.xlsx`,
  };
}

async function exportCsv(periodId) {
  const period = await getPeriodOrFail(periodId);
  const rows = await exportRows(periodId);
  const lines = [EXPORT_COLUMNS.map((c) => c.header).join(',')];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((c) => escapeCsv(row[c.key])).join(','));
  }
  return {
    buffer: Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8'),
    filename: `payroll-${period.period_year}-${String(period.period_month).padStart(2, '0')}.csv`,
  };
}

function escapeCsv(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Integrasi absensi: daftar karyawan yang layak diproses
// ---------------------------------------------------------------------------

async function eligibleEmployees(periodId) {
  const period = await getPeriodOrFail(periodId);
  const rows = await db.queryAll(
    `SELECT e.id, e.employee_code, e.name, dep.name AS department_name, pos.name AS position_name,
            COALESCE(s.base_salary, 0) AS base_salary,
            COALESCE(s.payroll_enabled, 1) AS payroll_enabled,
            (SELECT COUNT(*) FROM attendance_daily d
              WHERE d.employee_id = e.id AND d.work_date BETWEEN ? AND ? AND d.status <> 'hari_libur') AS work_days,
            (SELECT COUNT(*) FROM payroll_items it WHERE it.period_id = ? AND it.employee_id = e.id) AS already
       FROM employees e
       LEFT JOIN departments dep ON dep.id = e.department_id
       LEFT JOIN positions pos ON pos.id = e.position_id
       LEFT JOIN payroll_employee_salary s ON s.employee_id = e.id
      WHERE e.status <> 'resign' AND (e.hire_date IS NULL OR e.hire_date <= ?)
      ORDER BY e.name ASC`,
    [period.start_date, period.end_date, periodId, period.end_date]
  );
  return rows.map((r) => ({
    ...r,
    base_salary: roundIdr(r.base_salary),
    payroll_enabled: Number(r.payroll_enabled),
    work_days: Number(r.work_days),
    already: Number(r.already),
  }));
}

module.exports = {
  // komponen
  listComponents,
  getComponent,
  createComponent,
  updateComponent,
  removeComponent,
  ensureDefaultComponents,
  // gaji per karyawan
  getEmployeeSalary,
  setEmployeeSalary,
  listEmployeeComponents,
  setEmployeeComponent,
  removeEmployeeComponent,
  effectiveComponents,
  // absensi
  attendanceSummary,
  // periode
  listPeriods,
  getPeriod,
  getPeriodOrFail,
  createPeriod,
  deletePeriod,
  recalcPeriod,
  listItems,
  getItem,
  correctItem,
  approvePeriod,
  payPeriod,
  reopenPeriod,
  periodSummary,
  eligibleEmployees,
  // slip
  buildSlip,
  listEmployeeSlips,
  getEmployeeSlip,
  // audit
  writeAudit,
  listAudit,
  // ekspor
  exportExcel,
  exportCsv,
  // util
  periodRange,
  periodLabel,
  LAW: { TYPES, METHODS, PERCENT_BASES },
  formatIdr,
};
