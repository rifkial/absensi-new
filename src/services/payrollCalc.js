'use strict';

const { roundIdr, percentOf, formatIdr } = require('./payrollMoney');

/**
 * Perhitungan payroll murni (tanpa DB) supaya mudah diuji.
 *
 * Aturan:
 *  - Komponen "penghasilan" dihitung lebih dulu karena komponen persen
 *    (iuran/PPh) memakai hasilnya sebagai dasar (bruto / dasar pajak).
 *  - Total penghasilan, dasar pajak (taxable_base), dan dasar BPJS dihitung
 *    dari baris penghasilan sesuai flag komponen.
 *  - Beban perusahaan TIDAK mengurangi gaji karyawan; hanya info biaya.
 *  - Semua nominal dibulatkan ke rupiah penuh agar slip = rekap.
 */

function parseRule(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const obj = JSON.parse(value);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function resolveComponent(component, override) {
  const merged = { ...component };
  if (override) {
    if (override.amount !== null && override.amount !== undefined) merged.amount = override.amount;
    if (override.percent !== null && override.percent !== undefined) merged.percent = override.percent;
    if (override.rule_json !== null && override.rule_json !== undefined) merged.rule_json = override.rule_json;
    if (override.is_active !== null && override.is_active !== undefined) merged.is_active = override.is_active;
  }
  return merged;
}

const PRESENT_STATUSES = ['hadir', 'telat', 'dinas_luar', 'dinas_dalam'];

/** Hitung satu baris komponen; mengembalikan { amount, base_amount, percent, detail }. */
function computeLine(component, ctx) {
  const att = ctx.attendance;
  const method = component.calc_method;
  const rule = parseRule(component.rule_json);
  const amount = roundIdr(component.amount);

  if (component.category === 'gaji_pokok') {
    return { amount: roundIdr(ctx.baseSalary), base_amount: 0, percent: null, detail: null };
  }

  switch (method) {
    case 'persen': {
      const base = baseFor(component.percent_base, ctx);
      const pct = component.percent === null || component.percent === undefined ? 0 : component.percent;
      return {
        amount: percentOf(base, pct),
        base_amount: base,
        percent: pct,
        detail: `${pct}% x ${formatIdr(base)}`,
      };
    }
    case 'absensi': {
      const parts = [];
      let total = 0;
      const map = {
        per_hadir: ['hari hadir', att.daysPresent],
        per_hari_kerja: ['hari kerja', att.daysWork],
        per_terlambat: ['hari terlambat', att.daysLate],
        per_alpa: ['hari alpa', att.daysAbsent],
        per_izin: ['hari izin', att.daysLeave],
        per_sakit: ['hari sakit', att.daysSick || 0],
        per_cuti: ['hari cuti', att.daysCutoff || 0],
      };
      for (const [key, [label, count]] of Object.entries(map)) {
        const rate = roundIdr(rule[key]);
        if (rate === 0 || !count) continue;
        const subtotal = rate * count;
        total += subtotal;
        parts.push(`${count} ${label} x ${formatIdr(rate)}`);
      }
      return { amount: roundIdr(total), base_amount: 0, percent: null, detail: parts.join(', ') || null };
    }
    case 'lembur': {
      const perJam = roundIdr(rule.per_jam);
      const hours = att.overtimeMinutes / 60;
      const subtotal = Math.round(perJam * hours);
      return {
        amount: roundIdr(subtotal),
        base_amount: perJam,
        percent: null,
        detail: perJam ? `${hours.toFixed(2)} jam x ${formatIdr(perJam)}` : null,
      };
    }
    case 'manual':
    default:
      return { amount, base_amount: 0, percent: null, detail: null };
  }
}

function baseFor(percentBase, ctx) {
  switch (percentBase) {
    case 'bruto':
      return roundIdr(ctx.totalEarning);
    case 'tunjangan':
      return roundIdr(ctx.totalEarning - ctx.baseSalary);
    case 'penghasilan_netto':
      return roundIdr(ctx.taxableBase);
    case 'gaji_pokok':
    default:
      return roundIdr(ctx.baseSalary);
  }
}

/**
 * Hitung seluruh baris payroll seorang karyawan.
 */
function computePayroll({ baseSalary = 0, components = [], attendance = {} }) {
  const att = {
    daysWork: Number(attendance.daysWork || 0),
    daysPresent: Number(attendance.daysPresent || 0),
    daysLate: Number(attendance.daysLate || 0),
    daysAbsent: Number(attendance.daysAbsent || 0),
    daysLeave: Number(attendance.daysLeave || 0),
    daysSick: Number(attendance.daysSick || 0),
    daysCutoff: Number(attendance.daysCutoff || 0),
    lateMinutes: Number(attendance.lateMinutes || 0),
    overtimeMinutes: Number(attendance.overtimeMinutes || 0),
  };

  const income = components.filter((c) => c.type === 'penghasilan');
  const deductions = components.filter((c) => c.type === 'potongan');
  const company = components.filter((c) => c.type === 'beban_perusahaan');

  const ctx = { baseSalary: roundIdr(baseSalary), totalEarning: 0, taxableBase: 0, bpjsBase: 0, attendance: att };

  const deferredPercent = income.filter(
    (c) => c.calc_method === 'persen' && c.percent_base !== 'gaji_pokok'
  );
  const immediate = income.filter(
    (c) => !(c.calc_method === 'persen' && c.percent_base !== 'gaji_pokok')
  );

  const incomeLines = [];
  for (const component of [...immediate, ...deferredPercent]) {
    const line = computeLine(component, ctx);
    incomeLines.push({ component, line });
    ctx.totalEarning += line.amount;
    if (Number(component.taxable)) ctx.taxableBase += line.amount;
    if (Number(component.bpjs_base)) ctx.bpjsBase += line.amount;
  }

  const allLines = [];
  for (const { component, line } of incomeLines) {
    allLines.push({
      component_id: component.id ?? null,
      component_code: component.code,
      component_name: component.name,
      type: component.type,
      calc_method: component.calc_method,
      base_amount: line.base_amount,
      percent: line.percent,
      amount: line.amount,
      taxable: Number(component.taxable) ? 1 : 0,
      bpjs_base: Number(component.bpjs_base) ? 1 : 0,
      detail: line.detail,
      sort_order: component.sort_order ?? 100,
    });
  }
  for (const component of [...deductions, ...company]) {
    const line = computeLine(component, ctx);
    allLines.push({
      component_id: component.id ?? null,
      component_code: component.code,
      component_name: component.name,
      type: component.type,
      calc_method: component.calc_method,
      base_amount: line.base_amount,
      percent: line.percent,
      amount: line.amount,
      taxable: Number(component.taxable) ? 1 : 0,
      bpjs_base: Number(component.bpjs_base) ? 1 : 0,
      detail: line.detail,
      sort_order: component.sort_order ?? 100,
    });
  }
  allLines.sort((a, b) => a.sort_order - b.sort_order || a.component_code.localeCompare(b.component_code));

  const totalEarning = ctx.totalEarning;
  const totalDeduction = allLines.filter((l) => l.type === 'potongan').reduce((s, l) => s + l.amount, 0);
  const totalCompany = allLines.filter((l) => l.type === 'beban_perusahaan').reduce((s, l) => s + l.amount, 0);

  return {
    lines: allLines,
    totals: {
      baseSalary: roundIdr(baseSalary),
      totalEarning: roundIdr(totalEarning),
      totalDeduction: roundIdr(totalDeduction),
      totalCompany: roundIdr(totalCompany),
      taxableBase: roundIdr(ctx.taxableBase),
      bpjsBase: roundIdr(ctx.bpjsBase),
      netSalary: roundIdr(totalEarning - totalDeduction),
    },
    attendance: att,
    presentStatuses: PRESENT_STATUSES,
  };
}

module.exports = { computePayroll, computeLine, parseRule, resolveComponent, baseFor };
