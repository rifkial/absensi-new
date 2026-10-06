'use strict';

/**
 * Tes helper tanggal: parsing work_days, validasi ketat, dan label hari.
 *
 * Aturan utama yang dijaga di sini: hari Minggu (isoWeekday 7) tidak pernah
 * dihitung sebagai hari kerja, apa pun isi work_days.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWorkDays,
  parseWorkDaysStrict,
  workDaysLabel,
  isWorkDay,
  ISO_DAY_NAMES,
  SUNDAY_ISO,
} = require('../src/utils/date');

// 2026-03-02 = Senin ... 2026-03-08 = Minggu
const MONDAY = '2026-03-02';
const FRIDAY = '2026-03-06';
const SATURDAY = '2026-03-07';
const SUNDAY = '2026-03-08';

test('SUNDAY_ISO bernilai 7 (isoWeekday)', () => {
  assert.equal(SUNDAY_ISO, 7);
  assert.equal(ISO_DAY_NAMES[SUNDAY_ISO - 1], 'Minggu');
});

test('parseWorkDays membuang nilai di luar 1-6', () => {
  assert.deepEqual(parseWorkDays('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWorkDays('0,1,6,8'), [1, 6]);
});

test('parseWorkDays membuang Minggu (7) dari data lama', () => {
  // Instalasi lama bisa menyimpan work_days yang memuat 7 karena dulu
  // Minggu boleh dipilih. Nilai itu dibuang diam-diam agar hari Minggu
  // tidak ikut terhitung pada data lama maupun baru.
  assert.deepEqual(parseWorkDays('1,2,3,4,5,7'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWorkDays('7'), []);
  assert.deepEqual(parseWorkDays([1, 7, 6]), [1, 6]);
});

test('parseWorkDays menerima input kosong dan null', () => {
  assert.deepEqual(parseWorkDays(''), []);
  assert.deepEqual(parseWorkDays(null), []);
  assert.deepEqual(parseWorkDays(undefined), []);
  assert.deepEqual(parseWorkDays('   '), []);
});

test('parseWorkDaysStrict menolak angka 0 dari UI versi lama', () => {
  assert.throws(() => parseWorkDaysStrict('0,1,2,3,4,5'), /1-6/);
});

test('parseWorkDaysStrict menolak angka di atas 6', () => {
  assert.throws(() => parseWorkDaysStrict('1,8'), /di luar rentang/);
});

test('parseWorkDaysStrict menolak nilai non-numerik', () => {
  assert.throws(() => parseWorkDaysStrict('Senin,Selasa'), /tidak valid/);
});

test('parseWorkDaysStrict menolak daftar kosong', () => {
  assert.throws(() => parseWorkDaysStrict(''), /minimal satu hari kerja/);
  assert.throws(() => parseWorkDaysStrict([]), /minimal satu hari kerja/);
});

test('parseWorkDaysStrict menolak Minggu dengan pesan jelas', () => {
  assert.throws(() => parseWorkDaysStrict('7'), /Minggu tidak bisa dipilih/);
  assert.throws(() => parseWorkDaysStrict([1, 7]), /Minggu tidak bisa dipilih/);
  assert.throws(() => parseWorkDaysStrict('1,2,3,4,5,7'), /Minggu tidak bisa dipilih/);
});

test('parseWorkDaysStrict menolak daftar yang hanya berisi Minggu', () => {
  // Bukan sekadar "tidak valid" tapi harus menjelaskan tidak ada hari kerja
  // yang tersisa setelah Minggu dibuang.
  assert.throws(() => parseWorkDaysStrict('7'), /Minggu tidak bisa dipilih/);
});

test('parseWorkDaysStrict membuang duplikat dan mengurutkan', () => {
  assert.deepEqual(parseWorkDaysStrict('5,1,5,3,1'), [1, 3, 5]);
});

test('parseWorkDaysStrict menerima Sabtu sebagai hari kerja', () => {
  assert.deepEqual(parseWorkDaysStrict('6'), [6]);
  assert.deepEqual(parseWorkDaysStrict('1,2,3,4,5,6'), [1, 2, 3, 4, 5, 6]);
});

test('workDaysLabel memakai nama ISO dan tidak pernah menampilkan Minggu', () => {
  assert.equal(workDaysLabel('1,2,3,4,5'), 'Senin, Selasa, Rabu, Kamis, Jumat');
  assert.equal(workDaysLabel('1,6', { short: true }), 'Sen, Sab');
  assert.equal(workDaysLabel(''), '');
  // Data lama yang memuat 7 tetap tampil tanpa Minggu.
  assert.equal(workDaysLabel('1,2,3,4,5,7'), 'Senin, Selasa, Rabu, Kamis, Jumat');
  assert.equal(workDaysLabel('7'), '');
});

test('isWorkDay: hari kerja biasa mengikuti work_days', () => {
  assert.equal(isWorkDay('1,2,3,4,5', MONDAY), true);
  assert.equal(isWorkDay('1,2,3,4,5', FRIDAY), true);
  assert.equal(isWorkDay('1,2,3,4,5', SATURDAY), false);
});

test('isWorkDay: Minggu SELALU bukan hari kerja walau work_days memuat 7', () => {
  assert.equal(isWorkDay('1,2,3,4,5', SUNDAY), false);
  assert.equal(isWorkDay('1,2,3,4,5,7', SUNDAY), false);
  assert.equal(isWorkDay('1,2,3,4,5,6,7', SUNDAY), false);
  assert.equal(isWorkDay('7', SUNDAY), false);
});

test('isWorkDay: work_days kosong tetap menganggap semua hari kecuali Minggu sebagai kerja', () => {
  // karyawan tanpa shift tetap diharapkan kerja, tapi bukan pada hari Minggu.
  assert.equal(isWorkDay('', MONDAY), true);
  assert.equal(isWorkDay(null, MONDAY), true);
  assert.equal(isWorkDay('', SUNDAY), false);
  assert.equal(isWorkDay(null, SUNDAY), false);
});

test('isWorkDay: hari kerja 6 hari (termasuk Sabtu) tidak membuat Minggu jadi kerja', () => {
  assert.equal(isWorkDay('1,2,3,4,5,6', SATURDAY), true);
  assert.equal(isWorkDay('1,2,3,4,5,6', SUNDAY), false);
});