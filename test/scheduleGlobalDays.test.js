'use strict';

/**
 * Tes helper untuk generate-schedule: daftar hari kerja global dari form
 * pembuatan jadwal.
 *
 * Fungsi di src/routes/shifts.js inline di dalam handler Express, jadi yang
 * bisa diuji tanpa HTTP adalah periautannya lewat helper date yang sama.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseWorkDaysStrict, isWorkDay } = require('../src/utils/date');

// 2026-03-02 Senin, 06 Jumat, 07 Sabtu, 08 Minggu
const SENIN = '2026-03-02';
const JUMAT = '2026-03-06';
const SABTU = '2026-03-07';
const MINGGU = '2026-03-08';

test('generate-schedule menerima daftar hari kerja global', () => {
  const days = parseWorkDaysStrict('1,2,3,4,5', { label: 'work_days' });
  assert.deepEqual(days, [1, 2, 3, 4, 5]);
});

test('generate-schedule menerima jadwal 6 hari kerja', () => {
  const days = parseWorkDaysStrict('1,2,3,4,5,6', { label: 'work_days' });
  assert.deepEqual(days, [1, 2, 3, 4, 5, 6]);
  assert.equal(isWorkDay(days.join(','), SABTU), true);
});

test('generate-schedule menolak Minggu pada jadwal global', () => {
  assert.throws(
    () => parseWorkDaysStrict('1,2,3,4,5,7', { label: 'work_days' }),
    /Minggu tidak bisa dipilih/
  );
  assert.throws(() => parseWorkDaysStrict('7', { label: 'work_days' }), /Minggu tidak bisa dipilih/);
});

test('generate-schedule menolak daftar kosong', () => {
  assert.throws(() => parseWorkDaysStrict('', { label: 'work_days' }), /wajib diisi/);
});

test('Minggu tetap libur walau jadwal global memuat semua hari kerja', () => {
  const days = [1, 2, 3, 4, 5, 6];
  assert.equal(isWorkDay(days.join(','), MINGGU), false);
  assert.equal(isWorkDay(days.join(','), JUMAT), true);
});

test('jadwal global bisa mengubah hari kerja dari Senin-Jumat ke Jumat-Sabtu', () => {
  const hanyaJumatSabtu = '5,6';
  assert.equal(isWorkDay(hanyaJumatSabtu, JUMAT), true);
  assert.equal(isWorkDay(hanyaJumatSabtu, SABTU), true);
  assert.equal(isWorkDay(hanyaJumatSabtu, SENIN), false);
});