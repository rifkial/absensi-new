'use strict';

/**
 * Tes computeDaily: hari libur dari tabel holidays.
 *
 * Libur harus menang atas perhitungan shift, tapi kalah dari jadwal per tanggal
 * dan dari dinas luar (tugas lapangan tetap dihitung kerja).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDaily, STATUS } = require('../src/services/attendance');

const EMPLOYEE = { id: 1, name: 'Uji', employee_code: 'U01', status: 'aktif' };

const SHIFT = {
  id: 1,
  start_time: '08:00:00',
  end_time: '17:00:00',
  break_start: '12:00:00',
  break_end: '13:00:00',
  work_days: '1,2,3,4,5',
  late_tolerance_min: 10,
  max_work_minutes: 480,
};

function scan(time) {
  return [{ id: 1, log_time: time, log_state: 0, verify_mode: 0 }];
}

test('tanggal libur tanpa scan berstatus hari_libur', () => {
  const r = computeDaily({
    employee: EMPLOYEE,
    workDate: '2026-01-01',
    shift: SHIFT,
    dayType: null,
    logs: [],
    leave: null,
    holiday: { holiday_date: '2026-01-01', name: 'Tahun Baru 2026 Masehi' },
    now: new Date('2026-01-01T10:00:00'),
  });

  assert.equal(r.status, STATUS.HARI_LIBUR);
  assert.equal(r.note, 'Tahun Baru 2026 Masehi');
});

test('scan pada hari libur dihitung hadir tanpa penalti telat', () => {
  const r = computeDaily({
    employee: EMPLOYEE,
    workDate: '2026-01-01',
    shift: SHIFT,
    dayType: null,
    logs: scan('2026-01-01 09:30:00'),
    leave: null,
    holiday: { holiday_date: '2026-01-01', name: 'Tahun Baru' },
    now: new Date('2026-01-01T18:00:00'),
  });

  assert.equal(r.status, STATUS.HADIR);
  assert.equal(r.lateMinutes, 0);
  assert.match(r.note, /Tahun Baru/);
});

test('jadwal per tanggal libur menang atas hari libur nasional', () => {
  const r = computeDaily({
    employee: EMPLOYEE,
    workDate: '2026-01-01',
    shift: SHIFT,
    dayType: 'libur',
    logs: [],
    leave: null,
    holiday: { holiday_date: '2026-01-01', name: 'Tahun Baru' },
    now: new Date('2026-01-01T10:00:00'),
  });

  assert.equal(r.status, STATUS.HARI_LIBUR);
});

test('dinas luar pada hari libur tetap dihitung sebagai dinas', () => {
  const r = computeDaily({
    employee: EMPLOYEE,
    workDate: '2026-01-01',
    shift: SHIFT,
    dayType: null,
    logs: [],
    leave: null,
    duty: { id: 1, check_in_at: '2026-01-01 08:00:00', check_out_at: '2026-01-01 17:00:00', note: null },
    holiday: { holiday_date: '2026-01-01', name: 'Tahun Baru' },
    now: new Date('2026-01-01T18:00:00'),
  });

  assert.equal(r.status, STATUS.DINAS_LUAR);
});

test('tanpa holiday, hari kerja biasa tetap dihitung telat', () => {
  const r = computeDaily({
    employee: EMPLOYEE,
    workDate: '2026-06-08',
    shift: SHIFT,
    dayType: null,
    logs: scan('2026-06-08 08:30:00'),
    leave: null,
    holiday: null,
    now: new Date('2026-06-08T18:00:00'),
  });

  // Scan 08:30 vs jam shift 08:00 = 30 menit telat (toleransi 10 menit).
  assert.equal(r.status, STATUS.TELAT);
  assert.equal(r.lateMinutes, 30);
});
