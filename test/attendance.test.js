'use strict';

/**
 * Tes perhitungan rekap harian (computeDaily).
 *
 * Fungsi ini murni: semua masukan (scan, shift, pengajuan, dinas) dikirim
 * sebagai argumen, jadi bisa diuji tanpa database. Ini inti perhitungan
 * kehadiran, jadi paling rawan salah kalau ever berubah.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDaily, STATUS } = require('../src/services/attendance');
const { today, addDays } = require('../src/utils/date');

const SHIFT = {
  id: 1,
  code: 'PAGI',
  name: 'Shift Pagi',
  start_time: '08:00:00',
  end_time: '17:00:00',
  break_start: '12:00:00',
  break_end: '13:00:00',
  work_days: '1,2,3,4,5',
  late_tolerance_min: 10,
  max_work_minutes: 480,
};

const EMPLOYEE = { id: 1, name: 'Uji' };

/** Scan masuk/pulang pada tanggal tertentu. */
function scans(date, times, states = []) {
  return times.map((time, i) => ({
    log_time: `${date} ${time}:00`,
    log_state: states[i] ?? 0,
    verify_mode: 1,
  }));
}

/** Tanggal kerja pasti: besok atau 3 hari lalu, dipilih agar bukan akhir pekan. */
function workdayPast() {
  for (let i = 3; i < 10; i += 1) {
    const d = addDays(today(), -i);
    const dow = new Date(`${d}T00:00:00`).getDay(); // 0=Minggu
    if (dow >= 1 && dow <= 5) return d;
  }
  return addDays(today(), -3);
}

function workdayPastWeekend() {
  for (let i = 3; i < 10; i += 1) {
    const d = addDays(today(), -i);
    const dow = new Date(`${d}T00:00:00`).getDay();
    if (dow === 0 || dow === 6) return d;
  }
  return addDays(today(), -2);
}

function base(overrides = {}) {
  return {
    employee: EMPLOYEE,
    workDate: workdayPast(),
    shift: SHIFT,
    dayType: null,
    logs: [],
    leave: null,
    duty: null,
    ...overrides,
  };
}

test('scan tepat waktu berstatus hadir', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:00', '17:00'], [0, 1]),
  }));

  assert.equal(result.status, STATUS.HADIR);
  assert.equal(result.lateMinutes, 0);
});

test('scan dalam toleransi tidak dihitung telat', () => {
  const d = workdayPast();
  // Shift mulai 08:00, toleransi 10 menit -> 08:10 masih tepat waktu.
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:10', '17:00'], [0, 1]),
  }));

  assert.equal(result.status, STATUS.HADIR);
  assert.equal(result.lateMinutes, 0);
});

test('scan lewat toleransi dihitung telat sebesar menit keterlambatan', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:25', '17:00'], [0, 1]),
  }));

  assert.equal(result.status, STATUS.TELAT);
  // lateMinutes = selisih penuh dari jam shift (08:25 - 08:00), bukan
  // selisih setelah dikurangi toleransi.
  assert.equal(result.lateMinutes, 25);
});

test('durasi kerja dikurangi waktu istirahat', () => {
  const d = workdayPast();
  // 08:00-17:00 = 540 menit, istirahat 12:00-13:00 = 60 menit.
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:00', '17:00'], [0, 1]),
  }));

  assert.equal(result.workMinutes, 480);
});

test('lembur dihitung ketika kerja melewati batas shift', () => {
  const d = workdayPast();
  // 08:00-19:00 = 660 menit, dikurangi istirahat 60 = 600.
  // Batas lembur = max_work_minutes 480 -> lembur 120 menit.
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:00', '19:00'], [0, 1]),
  }));

  assert.equal(result.workMinutes, 600);
  assert.equal(result.overtimeMinutes, 120);
});

test('hari libur tanpa scan berstatus hari_libur', () => {
  const result = computeDaily(base({
    workDate: workdayPastWeekend(),
    logs: [],
  }));

  assert.equal(result.status, STATUS.HARI_LIBUR);
});

test('scan di hari libur tetap dihitung hadir', () => {
  const d = workdayPastWeekend();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['09:00', '12:00'], [0, 1]),
  }));

  assert.equal(result.status, STATUS.HADIR);
});

test('day_type libur dari jadwal manual_libur', () => {
  const result = computeDaily(base({ dayType: 'libur', logs: [] }));
  assert.equal(result.status, STATUS.HARI_LIBUR);
});

test('tidak scan pada hari kerja yang sudah lewat berstatus alpa', () => {
  const result = computeDaily(base({ logs: [] }));
  assert.equal(result.status, STATUS.ALPA);
});

test('scan pertama yang dipakai, bukan scan terakhir', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:05', '12:30', '17:00'], [0, 2, 1]),
  }));

  assert.equal(String(result.firstIn).includes('08:05'), true);
  assert.equal(String(result.firstOut).includes('17:00'), true);
});

test('scan paling awal menentukan jam masuk walau urutan acak', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['17:00', '08:00'], [1, 0]),
  }));

  assert.equal(String(result.firstIn).includes('08:00'), true);
});

test('hanya ada scan keluar, scan itu dipakai sebagai jam masuk', () => {
  const d = workdayPast();
  // Sesuai perilaku yang disengaja: bila tidak ada scan masuk eksplisit,
  // scan pertama apa pun dipakai sebagai jam masuk, dan dihitung telat.
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['17:00'], [1]),
  }));

  assert.equal(String(result.firstIn).includes('17:00'), true);
  assert.equal(String(result.firstOut).includes('17:00'), true);
  assert.equal(result.lateMinutes, 540); // 17:00 - 08:00
  assert.equal(result.status, STATUS.TELAT);
});

test('izin yang disetujui menutupi hari tanpa scan', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: [],
    leave: { leave_type: 'izin', subtype: 'izin_tidak_masuk', start_date: d, end_date: d },
  }));

  assert.equal(result.status, STATUS.IZIN);
});

test('cuti sakit memakai status sakit, bukan cuti', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: [],
    leave: { leave_type: 'cuti', subtype: 'cuti_sakit', start_date: d, end_date: d },
  }));

  assert.equal(result.status, STATUS.SAKIT);
});

test('cuti tahunan memakai status cuti', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: [],
    leave: { leave_type: 'cuti', subtype: 'cuti_tahunan', start_date: d, end_date: d },
  }));

  assert.equal(result.status, STATUS.CUTI);
});

test('dinas luar tetap dihitung kerja walau tanpa scan mesin', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: [],
    duty: { check_in_at: `${d} 08:00:00`, check_out_at: `${d} 17:00:00`, note: 'Tugas' },
  }));

  assert.equal(result.status, STATUS.DINAS_LUAR);
  assert.equal(result.workMinutes, 480);
});

test('dinas lebih didahulukan daripada pengajuan cuti', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: [],
    leave: { leave_type: 'cuti', subtype: 'cuti_tahunan', start_date: d, end_date: d },
    duty: { check_in_at: `${d} 08:00:00`, check_out_at: `${d} 17:00:00`, note: 'Tugas' },
  }));

  assert.equal(result.status, STATUS.DINAS_LUAR);
});

test('tanpa shift, scan pertama tetap dihitung hadir', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    shift: null,
    logs: scans(d, ['09:00', '17:00'], [0, 1]),
  }));

  assert.equal(result.status, STATUS.HADIR);
});

test('tanpa shift dan tanpa scan di hari lewat berstatus alpa', () => {
  const result = computeDaily(base({ shift: null, logs: [] }));
  assert.equal(result.status, STATUS.ALPA);
});

test('izin setengah hari tetap menghitung jam kerja dari scan', () => {
  const d = workdayPast();
  const result = computeDaily(base({
    workDate: d,
    logs: scans(d, ['08:00', '12:00'], [0, 1]),
    leave: { leave_type: 'izin', subtype: 'izin_pulang_cepat', start_date: d, end_date: d },
  }));

  assert.equal(result.status, STATUS.IZIN);
  // 08:00-12:00 = 240 menit, dikurangi istirahat shift 12:00-13:00 = 60 menit.
  assert.equal(result.workMinutes, 180);
});
