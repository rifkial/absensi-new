'use strict';

/**
 * Tes helper shift (src/services/shifts.js).
 *
 * Fungsi-fungsi ini menentukan toleransi telat, durasi kerja, dan batas lembur,
 * jadi salah di sini langsung merusak angka jam kerja di laporan.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isWorkingDay,
  isOvernight,
  toleranceOf,
  shiftDurationMinutes,
  maxWorkMinutesOf,
  parseDayTimes,
  forDate,
} = require('../src/services/shifts');

const PAGI = {
  id: 1,
  start_time: '08:00:00',
  end_time: '17:00:00',
  break_start: '12:00:00',
  break_end: '13:00:00',
  work_days: '1,2,3,4,5',
  late_tolerance_min: 10,
  max_work_minutes: 480,
};

test('isWorkingDay mengikuti work_days shift', () => {
  assert.equal(isWorkingDay(PAGI, '2026-03-02'), true); // Senin
  assert.equal(isWorkingDay(PAGI, '2026-03-06'), true); // Jumat
  assert.equal(isWorkingDay(PAGI, '2026-03-07'), false); // Sabtu
  assert.equal(isWorkingDay(PAGI, '2026-03-01'), false); // Minggu
});

test('isWorkingDay tanpa shift dianggap hari kerja', () => {
  assert.equal(isWorkingDay(null, '2026-03-07'), true);
});

test('toleranceOf memakai nilai shift bila ada', () => {
  assert.equal(toleranceOf(PAGI), 10);
});

test('toleranceOf jatuh ke default bila shift kosong', () => {
  // DEFAULT_LATE_TOLERANCE di .env example = 10; cukup memastikan tidak error.
  assert.equal(typeof toleranceOf(null), 'number');
  assert.equal(toleranceOf({ late_tolerance_min: null }), toleranceOf(null));
});

test('shiftDurationMinutes mengurangi istirahat', () => {
  // 08:00-17:00 = 540 menit, istirahat 60 menit -> 480.
  assert.equal(shiftDurationMinutes(PAGI), 480);
});

test('shiftDurationMinutes tanpa istirahat', () => {
  assert.equal(
    shiftDurationMinutes({
      start_time: '08:00:00',
      end_time: '17:00:00',
      break_start: null,
      break_end: null,
    }),
    540
  );
});

test('shiftDurationMinutes menangani shift lintas tengah malam', () => {
  // 22:00-06:00 = 8 jam = 480 menit.
  const malam = {
    start_time: '22:00:00',
    end_time: '06:00:00',
    break_start: null,
    break_end: null,
  };
  assert.equal(shiftDurationMinutes(malam), 480);
});

test('shiftDurationMinutes tanpa shift bernilai nol', () => {
  assert.equal(shiftDurationMinutes(null), 0);
});

test('maxWorkMinutesOf memakai nilai shift bila ada', () => {
  assert.equal(maxWorkMinutesOf(PAGI), 480);
});

test('maxWorkMinutesOf jatuh ke default bila kosong', () => {
  assert.equal(maxWorkMinutesOf(null), maxWorkMinutesOf({ max_work_minutes: null }));
});

test('isOvernight mendeteksi shift malam lintas hari', () => {
  assert.equal(isOvernight({ start_time: '23:00:00', end_time: '07:00:00' }), true);
  assert.equal(isOvernight({ start_time: '22:00:00', end_time: '06:00:00' }), true);
  assert.equal(isOvernight({ start_time: '07:00:00', end_time: '15:00:00' }), false);
  assert.equal(isOvernight({ start_time: '15:00:00', end_time: '23:00:00' }), false);
  assert.equal(isOvernight(null), false);
});

test('forDate memakai override jam khusus Sabtu', () => {
  const shift = {
    start_time: '08:00:00',
    end_time: '17:00:00',
    work_days: '1,2,3,4,5,6',
    day_times: JSON.stringify({ 6: { start: '08:00', end: '15:30' } }),
  };
  // 2026-10-17 = Sabtu, 2026-10-19 = Senin.
  const sabtu = forDate(shift, '2026-10-17');
  assert.equal(String(sabtu.end_time).slice(0, 5), '15:30');
  const senin = forDate(shift, '2026-10-19');
  assert.equal(String(senin.end_time).slice(0, 5), '17:00');
});

test('forDate tanpa day_times mengembalikan shift asli', () => {
  assert.equal(forDate({ start_time: '08:00:00', end_time: '17:00:00' }, '2026-10-17').end_time, '17:00:00');
  assert.equal(forDate(null, '2026-10-17'), null);
});

test('parseDayTimes membuang jam tidak valid', () => {
  assert.deepEqual(parseDayTimes(null), {});
  assert.deepEqual(parseDayTimes('bukan-json'), {});
  const parsed = parseDayTimes({ 6: { start: '08:00', end: '15:30' }, 9: { start: 'xx' } });
  assert.ok(parsed[6]);
  assert.equal(parsed[9], undefined);
});
