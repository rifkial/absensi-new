'use strict';

/**
 * Tes payroll murni (tanpa database).
 *
 * computePayroll adalah inti perhitungan gaji: penghasilan, potongan berbasis
 * absensi/lembur/persen, beban perusahaan, dan pembulatan rupiah.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computePayroll } = require('../src/services/payrollCalc');
const { toNumber, roundIdr, percentOf, terbilang } = require('../src/services/payrollMoney');

function baseComponents() {
  return [
    { id: 1, code: 'GAJI_POKOK', name: 'Gaji Pokok', type: 'penghasilan', category: 'gaji_pokok', calc_method: 'tetap', amount: 0, percent: null, percent_base: 'gaji_pokok', taxable: 1, bpjs_base: 1, sort_order: 10 },
    { id: 2, code: 'TJ_ABSENSI', name: 'Tunjangan Absensi', type: 'penghasilan', category: 'tunjangan_absensi', calc_method: 'absensi', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: { per_hadir: 20000 }, taxable: 1, bpjs_base: 0, sort_order: 30 },
    { id: 3, code: 'LEMBUR', name: 'Uang Lembur', type: 'penghasilan', category: 'lembur', calc_method: 'lembur', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: { per_jam: 25000 }, taxable: 1, bpjs_base: 0, sort_order: 60 },
    { id: 8, code: 'IURAN_TK_KRY', name: 'Iuran TK', type: 'potongan', category: 'iuran_tk', calc_method: 'persen', amount: 0, percent: 2, percent_base: 'gaji_pokok', taxable: 0, bpjs_base: 0, sort_order: 110 },
    { id: 10, code: 'DENDA_ABSENSI', name: 'Denda Absensi', type: 'potongan', category: 'potongan_absensi', calc_method: 'absensi', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: { per_alpa: 50000, per_terlambat: 10000 }, taxable: 0, bpjs_base: 0, sort_order: 130 },
    { id: 11, code: 'PPH21', name: 'PPh 21', type: 'potongan', category: 'pph21', calc_method: 'persen', amount: 0, percent: 5, percent_base: 'bruto', taxable: 0, bpjs_base: 0, sort_order: 140 },
    { id: 13, code: 'BEBAN_TK_PRSH', name: 'Beban TK Perusahaan', type: 'beban_perusahaan', category: 'beban_tk', calc_method: 'persen', amount: 0, percent: 3.7, percent_base: 'gaji_pokok', taxable: 0, bpjs_base: 0, sort_order: 210 },
  ];
}

const ATT = { daysWork: 22, daysPresent: 20, daysLate: 2, daysAbsent: 2, daysLeave: 0, lateMinutes: 30, overtimeMinutes: 300 };

test('total penghasilan = pokok + tunjangan + lembur', () => {
  const out = computePayroll({ baseSalary: 5000000, components: baseComponents(), attendance: ATT });
  assert.equal(out.totals.totalEarning, 5000000 + 400000 + 125000);
});

test('potongan mengikuti aturan: iuran 2 persen + denda + PPh dari bruto', () => {
  const out = computePayroll({ baseSalary: 5000000, components: baseComponents(), attendance: ATT });
  // iuran = 2% x 5.000.000, denda = 2x50.000 + 2x10.000, PPh = 5% x bruto.
  assert.equal(out.totals.totalDeduction, 100000 + 120000 + 276250);
  assert.equal(out.totals.netSalary, out.totals.totalEarning - out.totals.totalDeduction);
});

test('beban perusahaan dicatat terpisah, tidak mengurangi gaji', () => {
  const out = computePayroll({ baseSalary: 5000000, components: baseComponents(), attendance: ATT });
  assert.equal(out.totals.totalCompany, 185000);
  assert.equal(out.totals.netSalary + out.totals.totalDeduction, out.totals.totalEarning);
});

test('dasar pajak dan dasar BPJS mengikuti flag komponen', () => {
  const out = computePayroll({ baseSalary: 5000000, components: baseComponents(), attendance: ATT });
  assert.equal(out.totals.taxableBase, 5525000);
  assert.equal(out.totals.bpjsBase, 5000000);
});

test('tanpa absensi: tunjangan absensi dan lembur nol', () => {
  const out = computePayroll({
    baseSalary: 4000000,
    components: baseComponents(),
    attendance: { daysWork: 0, daysPresent: 0, daysLate: 0, daysAbsent: 0, daysLeave: 0, overtimeMinutes: 0 },
  });
  assert.equal(out.lines.find((l) => l.component_code === 'TJ_ABSENSI').amount, 0);
  assert.equal(out.lines.find((l) => l.component_code === 'LEMBUR').amount, 0);
  assert.equal(out.totals.totalEarning, 4000000);
});

test('semua nominal hasil adalah rupiah penuh', () => {
  const out = computePayroll({
    baseSalary: 3333333,
    components: baseComponents(),
    attendance: { ...ATT, overtimeMinutes: 95 },
  });
  for (const line of out.lines) {
    assert.equal(line.amount, Math.round(line.amount));
  }
  assert.equal(out.totals.netSalary, Math.round(out.totals.netSalary));
});

test('toNumber membaca DECIMAL MySQL dan format Indonesia', () => {
  assert.equal(toNumber('3.7000'), 3.7);
  assert.equal(toNumber('5000000.00'), 5000000);
  assert.equal(toNumber('5.000.000'), 5000000);
  assert.equal(toNumber(''), 0);
});

test('percentOf membulatkan ke rupiah', () => {
  assert.equal(percentOf(5000000, 2), 100000);
  assert.equal(percentOf(5000000, 3.7), 185000);
});

test('roundIdr membulatkan setengah ke atas', () => {
  assert.equal(roundIdr('100.5'), 101);
  assert.equal(roundIdr('100.4'), 100);
});

test('terbilang rupiah bahasa Indonesia', () => {
  assert.equal(terbilang(1500000), 'Satu Juta Lima Ratus Ribu Rupiah');
  assert.equal(terbilang(0), 'Nol Rupiah');
  assert.equal(terbilang(5028750), 'Lima Juta Dua Puluh Delapan Ribu Tujuh Ratus Lima Puluh Rupiah');
});
