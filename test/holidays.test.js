'use strict';

/**
 * Tes parsing data hari libur dari API eksternal.
 *
 * Fungsi-fungsi ini yang menentukan apakah tanggal terbaca sebagai "cuti
 * bersama" atau "libur nasional", jadi bentuk respons yang berbeda harus
 * ditangani dengan benar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const holidays = require('../src/services/holidays');

const kemendesa = holidays.DEFAULT_SOURCES.find((s) => s.label === 'Kemendesa');
const hariLibur = holidays.DEFAULT_SOURCES.find((s) => s.label === 'api-hari-libur');

test('parser Kemendesa membaca libur nasional', () => {
  const items = kemendesa.parse({
    data: [
      { date: '2026-01-01', name: 'Tahun Baru 2026 Masehi', is_cuti_bersama: false },
      { date: '2026-08-17', name: 'Proklamasi Kemerdekaan', is_cuti_bersama: false },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].date, '2026-01-01');
  assert.equal(items[0].kind, 'nasional');
});

test('parser Kemendesa menandai is_cuti_bersama', () => {
  const items = kemendesa.parse({
    data: [{ date: '2026-03-20', name: 'Cuti Bersama Idul Fitri', is_cuti_bersama: true }],
  });

  assert.equal(items[0].kind, 'cuti_bersama');
});

test('parser Kemendesa membuang baris tanpa nama atau tanggal', () => {
  const items = kemendesa.parse({
    data: [{ date: '2026-01-01', name: '' }, { date: 'bukan tanggal', name: 'X' }, { date: '2026-02-01', name: 'Valid' }],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Valid');
});

test('parser api-hari-libur membaca field description', () => {
  const items = hariLibur.parse({
    data: [
      { date: '2026-01-01', description: 'Tahun Baru 2026 Masehi' },
      { date: '2026-03-18', description: 'Cuti Bersama Hari Suci Nyepi' },
    ],
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Tahun Baru 2026 Masehi');
  assert.equal(items[0].kind, 'nasional');
});

test('parser api-hari-libur mengenali awalan "Cuti Bersama"', () => {
  const items = hariLibur.parse({
    data: [{ date: '2026-03-20', description: 'Cuti Bersama Hari Raya Idul Fitri' }],
  });

  assert.equal(items[0].kind, 'cuti_bersama');
});

test('parser menoleransi respons kosong atau tidak terduga', () => {
  assert.deepEqual(kemendesa.parse(null), []);
  assert.deepEqual(kemendesa.parse({ data: [] }), []);
  assert.deepEqual(hariLibur.parse({ message: 'error' }), []);
});

test('KINDS memuat tiga jenis libur yang dipakai UI', () => {
  assert.deepEqual(holidays.KINDS, ['nasional', 'cuti_bersama', 'custom']);
  for (const kind of holidays.KINDS) {
    assert.ok(holidays.KIND_LABEL[kind], 'label harus ada untuk ' + kind);
  }
});

test('isHoliday membaca peta tanggal', () => {
  const map = new Map([['2026-01-01', { name: 'Tahun Baru' }]]);
  assert.equal(holidays.isHoliday(map, '2026-01-01'), true);
  assert.equal(holidays.isHoliday(map, '2026-01-02'), false);
  assert.equal(holidays.isHoliday(null, '2026-01-01'), false);
});
