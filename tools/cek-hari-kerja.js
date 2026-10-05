'use strict';
/**
 * Membuktikan hari Minggu (dan Sabtu) tidak dihitung sebagai hari kerja.
 * Tidak menulis apa pun ke database.
 * Jalankan: node tools/cek-hari-kerja.js
 */
const db = require('../src/db/pool');
const att = require('../src/services/attendance');
const s = require('../src/services/settings');
const shifts = require('../src/services/shifts');

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
// 1..7 = Senin..Minggu
const HARI_SINGKAT = { 1: 'Sen', 2: 'Sel', 3: 'Rab', 4: 'Kam', 5: 'Jum', 6: 'Sab', 7: 'Min' };

async function main() {
  const settings = await s.getAll({ refresh: true });
  att.invalidateGlobalShift();
  const global = await att.getGlobalShift();

  console.log('PENGATURAN HARI KERJA');
  console.log('----------------------');
  console.log('Pengaturan global_work_days : ' + settings.global_work_days);
  console.log('Shift global work_days      : ' + (global ? global.work_days : '(tidak aktif)'));
  console.log(
    'Artinya hari kerja          : ' +
      (global
        ? String(global.work_days)
            .split(',')
            .map((d) => HARI_SINGKAT[d.trim()])
            .join(', ')
        : '-')
  );
  console.log('');

  console.log('SHIFT TERSIMPAN DI DATABASE');
  console.log('--------------------------');
  const shiftsRows = await db.queryAll('SELECT code, name, work_days FROM shifts ORDER BY code');
  shiftsRows.forEach((r) => {
    const days = String(r.work_days).split(',').map((d) => HARI_SINGKAT[d.trim()]).join(', ');
    console.log('  ' + String(r.code).padEnd(6) + ' ' + String(r.name).padEnd(28) + ' ' + days);
  });
  console.log('');

  console.log('SIMULASI REKAP KARYAWAN 001 (tanpa shift, pakai jam global)');
  console.log('-------------------------------------------------------------');
  console.log('Tanggal    | Hari    | Status rekap');
  console.log('-----------+---------+-------------');
  for (const date of ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']) {
    const resolved = await att.resolveShift(1, date);
    const result = att.computeDaily({
      employee: { id: 1, shift_id: null },
      workDate: date,
      shift: resolved.shift,
      dayType: resolved.dayType,
      shiftSource: resolved.source,
      logs: [],
      leave: null,
      now: new Date(date + 'T10:00:00'),
    });
    const nama = HARI[new Date(date + 'T00:00:00').getDay()];
    console.log(date + ' | ' + nama.padEnd(7) + ' | ' + result.status);
  }

  console.log('');
  console.log('CEK HARI LIBUR DARI TABEL schedules');
  console.log('-----------------------------------');
  const lib = await db.queryAll(
    `SELECT COUNT(*) AS jml FROM schedules WHERE day_type = 'libur'`
  );
  console.log('  Baris jadwal libur: ' + (lib[0] ? lib[0].jml : 0));
  console.log('  (jadwal libur per karyawan overriding hari kerja shift)');

  await db.closePool();
  void shifts;
}

main().catch(async (e) => {
  console.error('GAGAL:', e.message);
  try { await db.closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});