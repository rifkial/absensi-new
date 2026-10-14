'use strict';

const DEFAULT_COMPONENTS = [
  { code: 'GAJI_POKOK', name: 'Gaji Pokok', type: 'penghasilan', category: 'gaji_pokok', calc_method: 'tetap', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 1, bpjs_base: 1, is_active: 1, sort_order: 10 },
  { code: 'TJ_JABATAN', name: 'Tunjangan Jabatan', type: 'penghasilan', category: 'tunjangan_jabatan', calc_method: 'tetap', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 1, bpjs_base: 1, is_active: 1, sort_order: 20 },
  { code: 'TJ_ABSENSI', name: 'Tunjangan Absensi', type: 'penghasilan', category: 'tunjangan_absensi', calc_method: 'absensi', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: '{"per_hadir":0}', taxable: 1, bpjs_base: 0, is_active: 1, sort_order: 30 },
  { code: 'TJ_BPJS_TK', name: 'Tunjangan BPJS Ketenagakerjaan', type: 'penghasilan', category: 'bpjs_tk', calc_method: 'tetap', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 1, bpjs_base: 0, is_active: 1, sort_order: 40 },
  { code: 'TJ_BPJS_KES', name: 'Tunjangan BPJS Kesehatan', type: 'penghasilan', category: 'bpjs_kes', calc_method: 'tetap', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 1, bpjs_base: 0, is_active: 1, sort_order: 50 },
  { code: 'LEMBUR', name: 'Uang Lembur', type: 'penghasilan', category: 'lembur', calc_method: 'lembur', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: '{"per_jam":0}', taxable: 1, bpjs_base: 0, is_active: 1, sort_order: 60 },
  { code: 'BONUS', name: 'Bonus & Insentif', type: 'penghasilan', category: 'bonus', calc_method: 'manual', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 1, bpjs_base: 0, is_active: 1, sort_order: 70 },
  { code: 'IURAN_TK_KRY', name: 'Iuran BPJS-TK Karyawan (JHT)', type: 'potongan', category: 'iuran_tk', calc_method: 'persen', amount: 0, percent: 2, percent_base: 'gaji_pokok', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 110 },
  { code: 'IURAN_KES_KRY', name: 'Iuran BPJS-Kes Karyawan', type: 'potongan', category: 'iuran_kes', calc_method: 'persen', amount: 0, percent: 1, percent_base: 'gaji_pokok', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 120 },
  { code: 'DENDA_ABSENSI', name: 'Denda / Potongan Absensi', type: 'potongan', category: 'potongan_absensi', calc_method: 'absensi', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: '{"per_terlambat":0,"per_alpa":0,"per_izin":0,"per_sakit":0,"per_cuti":0}', taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 130 },
  { code: 'PPH21', name: 'PPh 21', type: 'potongan', category: 'pph21', calc_method: 'persen', amount: 0, percent: 0, percent_base: 'bruto', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 140 },
  { code: 'POT_LAIN', name: 'Potongan Lainnya', type: 'potongan', category: 'potongan_lain', calc_method: 'manual', amount: 0, percent: null, percent_base: 'gaji_pokok', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 150 },
  { code: 'BEBAN_TK_PRSH', name: 'Iuran BPJS-TK Perusahaan (JHT)', type: 'beban_perusahaan', category: 'beban_tk', calc_method: 'persen', amount: 0, percent: 3.7, percent_base: 'gaji_pokok', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 210 },
  { code: 'BEBAN_KES_PRSH', name: 'Iuran BPJS-Kes Perusahaan', type: 'beban_perusahaan', category: 'beban_kes', calc_method: 'persen', amount: 0, percent: 4, percent_base: 'gaji_pokok', rule_json: null, taxable: 0, bpjs_base: 0, is_active: 1, sort_order: 220 },
];

module.exports = { DEFAULT_COMPONENTS };
