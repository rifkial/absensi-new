'use strict';

/**
 * Tes aturan "Minggu tidak pernah dihitung sebagai hari kerja" di sisi server.
 *
 * Yang diuji adalah jalur yang sama dengan produksi:
 *   - attendance.computeDaily  -> status hari Minggu
 *   - leaveQuota.countQuotaDays -> pemotong jatah cuti
 *   - shifts.isWorkingDay      -> Places untuk jadwal kerja
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDaily, STATUS, setForeignDeviceNames } = require('../src/services/attendance');
const { countQuotaDays } = require('../src/services/leaveQuota');
const shifts = require('../src/services/shifts');

const SHIFT = {
  id: 1,
  start_time: '08:00:00',
  end_time: '17:00:00',
  break_start: null,
  break_end: null,
  work_days: '1,2,3,4,5',
  late_tolerance_min: 10,
  max_work_minutes: 480,
};

// 2026-03-06 Jumat, 2026-03-07 Sabtu, 2026-03-08 Minggu
const JUMAT = '2026-03-06';
const SABTU = '2026-03-07';
const MINGGU = '2026-03-08';

function run({ workDays, workDate, logs = [] }) {
  return computeDaily({
    employee: { id: 1, name: 'Uji', device_id: null },
    workDate,
    shift: { ...SHIFT, work_days: workDays },
    dayType: null,
    logs,
    leave: null,
    now: new Date('2026-03-09T18:00:00'),
  });
}

function scan(time, workDate) {
  return { id: 1, log_time: `${workDate} ${time}:00`, log_state: 0, verify_mode: 0, device_id: 1 };
}

test.beforeEach(() => {
  setForeignDeviceNames(new Map());
});

test('Minggu jadi hari libur walau shift memuat work_days 1-7', () => {
  const r = run({ workDays: '1,2,3,4,5,6,7', workDate: MINGGU, logs: [] });
  assert.equal(r.status, STATUS.HARI_LIBUR);
});

test('Minggu tetap hari libur walau work_days hanya berisi 7', () => {
  const r = run({ workDays: '7', workDate: MINGGU, logs: [] });
  assert.equal(r.status, STATUS.HARI_LIBUR);
});

test('Minggu dengan scan tetap dihitung hadir tanpa penalti telat', () => {
  const r = run({ workDays: '1,2,3,4,5,6,7', workDate: MINGGU, logs: [scan('09:00', MINGGU)] });
  assert.equal(r.status, STATUS.HADIR);
  assert.equal(r.lateMinutes, 0);
});

test('Senin dan Jumat tetap hari kerja biasa', () => {
  assert.equal(run({ workDays: '1,2,3,4,5', workDate: '2026-03-02', logs: [scan('08:00', '2026-03-02')] }).status, STATUS.HADIR);
  assert.equal(run({ workDays: '1,2,3,4,5', workDate: JUMAT, logs: [scan('08:00', JUMAT)] }).status, STATUS.HADIR);
});

test('Minggu tanpa shift pun dianggap hari libur', () => {
  const r = computeDaily({
    employee: { id: 2, name: 'Tanpa Shift', device_id: null },
    workDate: MINGGU,
    shift: null,
    dayType: null,
    logs: [],
    leave: null,
    now: new Date('2026-03-09T18:00:00'),
  });
  assert.equal(r.status, STATUS.HARI_LIBUR);
});

test('Sabtu masih boleh jadi hari kerja bila shift 6 hari', () => {
  const r = run({ workDays: '1,2,3,4,5,6', workDate: SABTU, logs: [scan('08:00', SABTU)] });
  assert.equal(r.status, STATUS.HADIR);
});

test('Minggu tidak menambah hari kerja pada rekap', () => {
  // Jumat sampai Minggu = 3 hari kalender, hanya 2 hari kerja.
  const workDays = shifts.isWorkingDay({ work_days: '1,2,3,4,5,6,7' }, MINGGU);
  assert.equal(workDays, false);
});

test('isWorkingDay tanpa shift tetap false pada Minggu', () => {
  assert.equal(shifts.isWorkingDay(null, MINGGU), false);
  assert.equal(shifts.isWorkingDay(null, JUMAT), true);
});

test('countQuotaDays tidak memotong jatah untuk hari Minggu', () => {
  assert.equal(countQuotaDays('1,2,3,4,5', MINGGU, MINGGU), 0);
  assert.equal(countQuotaDays('1,2,3,4,5,6,7', MINGGU, MINGGU), 0);
  assert.equal(countQuotaDays(null, MINGGU, MINGGU), 0);
});

test('countQuotaDays menghitung hari kerja lain dalam rentang yang sama', () => {
  // Jumat 06 s/d Minggu 08 dengan shift Senin-Jumat = 1 hari.
  assert.equal(countQuotaDays('1,2,3,4,5', JUMAT, MINGGU), 1);
  // Tanpa work_days: Jumat + Sabtu = 2 (Minggu dilewati).
  assert.equal(countQuotaDays(null, JUMAT, MINGGU), 2);
});