'use strict';

/**
 * Tes helper tanggal: parsing work_days, validasi ketat, dan label hari.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWorkDays,
  parseWorkDaysStrict,
  workDaysLabel,
  isWorkDay,
  ISO_DAY_NAMES,
} = require('../src/utils/date');

test('parseWorkDays membuang nilai di luar 1-7 (perilaku lama, tidak berubah)', () => {
  assert.deepEqual(parseWorkDays('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWorkDays('0,1,6,7,8'), [1, 6, 7]);
});

test('parseWorkDaysStrict menolak angka 0 dari UI versi lama', () => {
  assert.throws(() => parseWorkDaysStrict('0,1,2,3,4,5'), /1-7/);
});

test('parseWorkDaysStrict menolak angka di atas 7', () => {
  assert.throws(() => parseWorkDaysStrict('1,8'), /di luar rentang/);
});

test('parseWorkDaysStrict menolak nilai non-numerik', () => {
  assert.throws(() => parseWorkDaysStrict('Senin,Selasa'), /tidak valid/);
});

test('parseWorkDaysStrict menolak daftar kosong', () => {
  assert.throws(() => parseWorkDaysStrict(''), /minimal satu hari kerja/);
  assert.throws(() => parseWorkDaysStrict([]), /minimal satu hari kerja/);
});

test('parseWorkDaysStrict menerima hari Minggu sebagai 7', () => {
  assert.deepEqual(parseWorkDaysStrict('7'), [7]);
  assert.deepEqual(parseWorkDaysStrict([1, 7]), [1, 7]);
});

test('parseWorkDaysStrict membuang duplikat dan mengurutkan', () => {
  assert.deepEqual(parseWorkDaysStrict('5,1,5,3,1'), [1, 3, 5]);
});

test('workDaysLabel memakai nama ISO (1=Senin, 7=Minggu)', () => {
  assert.equal(workDaysLabel('1,2,3,4,5'), 'Senin, Selasa, Rabu, Kamis, Jumat');
  assert.equal(workDaysLabel('7'), 'Minggu');
  assert.equal(workDaysLabel('1,6', { short: true }), 'Sen, Sab');
  assert.equal(workDaysLabel(''), '');
});

test('ISO_DAY_NAMES urut dari Senin sampai Minggu', () => {
  assert.equal(ISO_DAY_NAMES.length, 7);
  assert.equal(ISO_DAY_NAMES[0], 'Senin');
  assert.equal(ISO_DAY_NAMES[6], 'Minggu');
});

test('isWorkDay memakai ISO: work_days "1,2,3,4,5" tidak mengenali Sabtu/Minggu', () => {
  assert.equal(isWorkDay('1,2,3,4,5', '2026-03-07'), false); // Sabtu
  assert.equal(isWorkDay('1,2,3,4,5', '2026-03-08'), false); // Minggu
  assert.equal(isWorkDay('1,2,3,4,5,7', '2026-03-08'), true); // Minggu
});
