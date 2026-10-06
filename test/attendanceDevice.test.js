'use strict';

/**
 * Tes penandaan "absen di mesin lain".
 *
 * Aturan yang dijaga:
 *   - karyawan tanpa mesin yang ditunjuk tidak pernah ditandai
 *   - scan dari mesin yang ditunjuk tidak ditandai
 *   - scan dari mesin lain TETAP dihitung hadir, hanya diberi label
 *   - log tanpa device_id (impor CSV tanpa pilih mesin) tidak dianggap salah
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDaily, STATUS, setForeignDeviceNames } = require('../src/services/attendance');

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

/** Satu log scan. device_id null meniru impor CSV tanpa mesin. */
function scan(time, deviceId) {
  return { id: 1, log_time: time, log_state: 0, verify_mode: 0, device_id: deviceId };
}

/** Bungkus scan tunggal menjadi daftar log untuk computeDaily. */
function logs(time, deviceId) {
  return [scan(time, deviceId)];
}

function run({ employeeDeviceId, logs }) {
  return computeDaily({
    employee: { id: 1, name: 'Uji', device_id: employeeDeviceId },
    workDate: '2026-06-08',
    shift: SHIFT,
    dayType: null,
    logs,
    leave: null,
    now: new Date('2026-06-08T18:00:00'),
  });
}

test.beforeEach(() => {
  setForeignDeviceNames(new Map([[1, 'Mesin Lobby'], [2, 'Mesin Pabrik']]));
});

test('karyawan tanpa mesin ditunjuk tidak pernah ditandai', () => {
  const r = run({ employeeDeviceId: null, logs: logs('2026-06-08 08:00:00', 2) });

  assert.equal(r.wrongDevice, undefined);
  assert.equal(r.status, STATUS.HADIR);
});

test('scan dari mesin yang ditunjuk tidak ditandai', () => {
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:00:00', 1) });

  assert.equal(r.wrongDevice, undefined);
  assert.equal(r.status, STATUS.HADIR);
});

test('scan dari mesin lain tetap dihitung hadir', () => {
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:00:00', 2) });

  assert.equal(r.wrongDevice, true);
  assert.deepEqual(r.wrongDeviceIds, [2]);
  assert.deepEqual(r.wrongDeviceNames, ['Mesin Pabrik']);
  // Status tetap hadir, bukan alpa atau ditolak.
  assert.equal(r.status, STATUS.HADIR);
});

test('catatan rekap menyebut nama mesin yang salah', () => {
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:00:00', 2) });

  assert.match(r.note, /Mesin Pabrik/);
});

test('keterlambatan dari mesin lain tetap dihitung normal', () => {
  // Scan 08:30 vs jam shift 08:00 = 30 menit telat.
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:30:00', 2) });

  assert.equal(r.status, STATUS.TELAT);
  assert.equal(r.lateMinutes, 30);
  assert.equal(r.wrongDevice, true);
});

test('log tanpa device_id tidak dianggap scan mesin salah', () => {
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:00:00', null) });

  assert.equal(r.wrongDevice, undefined);
});

test('campuran mesin benar dan salah tetap ditandai', () => {
  const r = run({
    employeeDeviceId: 1,
    logs: [scan('2026-06-08 08:00:00', 1), scan('2026-06-08 12:00:00', 2)],
  });

  assert.equal(r.wrongDevice, true);
  assert.deepEqual(r.wrongDeviceIds, [2]);
});

test('hanya mesin yang tidak dikenal nama yang dipakai di catatan', () => {
  setForeignDeviceNames(new Map());
  const r = run({ employeeDeviceId: 1, logs: logs('2026-06-08 08:00:00', 99) });

  assert.equal(r.wrongDevice, true);
  assert.match(r.note, /1 mesin lain/);
});

test('tanpa scan tidak ada penandaan mesin lain', () => {
  const r = run({ employeeDeviceId: 1, logs: [] });

  assert.equal(r.wrongDevice, undefined);
});
