'use strict';

/**
 * Tes utilitas tanggal (src/utils/date.js).
 *
 * Fungsi-fungsi ini dipakai di seluruh perhitungan rekap, jadi harus benar
 * tanpa perlu database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dateRange,
  isWorkDay,
  parseWorkDays,
  isoDayOfWeek,
  timeToMinutes,
  minutesToTime,
  addDays,
  startOfMonth,
  endOfMonth,
  toDate,
  dayName,
  monthName,
  diffMinutes,
} = require('../src/utils/date');

test('dateRange menyertakan kedua ujung', () => {
  const days = dateRange('2026-03-02', '2026-03-05');
  assert.deepEqual(days, ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
});

test('dateRange handles satu hari', () => {
  assert.deepEqual(dateRange('2026-03-02', '2026-03-02'), ['2026-03-02']);
});

test('dateRange menolak tanggal terbalik', () => {
  // Awal setelah akhir -> tidak ada hari yang bisa dikembalikan.
  assert.deepEqual(dateRange('2026-03-05', '2026-03-02'), []);
});

test('isoDayOfWeek memakai konvensi 1=Senin .. 7=Minggu', () => {
  // 2026-03-02 adalah Senin, 2026-03-01 adalah Minggu.
  assert.equal(isoDayOfWeek('2026-03-02'), 1);
  assert.equal(isoDayOfWeek('2026-03-01'), 7);
  assert.equal(isoDayOfWeek('2026-03-07'), 6); // Sabtu
});

test('parseWorkDays menerima beberapa pemisah', () => {
  assert.deepEqual(parseWorkDays('1,2,3,4,5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWorkDays('1 2 3'), [1, 2, 3]);
  assert.deepEqual(parseWorkDays('1;4;5'), [1, 4, 5]);
});

test('parseWorkDays membuang nilai di luar 1..7', () => {
  assert.deepEqual(parseWorkDays('0,1,8,3'), [1, 3]);
});

test('isWorkDay hanya menerima hari yang terdaftar', () => {
  const kerja = '1,2,3,4,5'; // Senin-Jumat
  assert.equal(isWorkDay(kerja, '2026-03-02'), true); // Senin
  assert.equal(isWorkDay(kerja, '2026-03-06'), true); // Jumat
  assert.equal(isWorkDay(kerja, '2026-03-07'), false); // Sabtu
  assert.equal(isWorkDay(kerja, '2026-03-01'), false); // Minggu
});

test('isWorkDay tanpa daftar hari kerja menganggap semua hari kerja', () => {
  assert.equal(isWorkDay('', '2026-03-07'), true);
  assert.equal(isWorkDay(null, '2026-03-01'), true);
});

test('timeToMinutes dan minutesToTime bolak-balik', () => {
  assert.equal(timeToMinutes('08:00'), 480);
  assert.equal(timeToMinutes('17:30'), 1050);
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(minutesToTime(480), '08:00');
  assert.equal(minutesToTime(1050), '17:30');
});

test('minutesToTime menangani melingkar lewat tengah malam', () => {
  assert.equal(minutesToTime(1440), '00:00');
  assert.equal(minutesToTime(1500), '01:00');
});

test('timeToMinutes menolak jam tidak valid', () => {
  assert.equal(timeToMinutes('25:00', null), null);
  assert.equal(timeToMinutes('abc', null), null);
});

test('addDays melintasi bulan dan tahun', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-02', -1), '2026-03-01');
});

test('startOfMonth dan endOfMonth', () => {
  assert.equal(startOfMonth('2026-03-15'), '2026-03-01');
  assert.equal(endOfMonth('2026-03-15'), '2026-03-31');
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2024-02-10'), '2024-02-29'); // tahun kabisat
});

test('toDate menormalkan berbagai format', () => {
  assert.equal(toDate('2026-03-02'), '2026-03-02');
  assert.equal(toDate('02/03/2026'), '2026-03-02');
  assert.equal(toDate('2026-03-02 10:30:00'), '2026-03-02');
  assert.equal(toDate('tidak valid'), null);
});

test('diffMinutes menghitung selisih lintas jam', () => {
  assert.equal(diffMinutes('2026-03-02 17:00:00', '2026-03-02 08:00:00'), 540);
  assert.equal(diffMinutes('2026-03-02 08:00:00', '2026-03-02 17:00:00'), -540);
});

test('dayName dan monthName memakai bahasa Indonesia', () => {
  assert.equal(dayName('2026-03-02'), 'Senin');
  assert.equal(dayName('2026-03-01'), 'Minggu');
  assert.equal(monthName(3), 'Maret');
  assert.equal(monthName(12), 'Desember');
});
