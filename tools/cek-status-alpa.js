'use strict';
/**
 * Simulasi status absensi untuk semua kombinasi kondisi.
 * Tidak menulis apa pun ke database.
 * Jalankan: node tools/cek-status-alpa.js
 */
const db = require('../src/db/pool');
const att = require('../src/services/attendance');
const s = require('../src/services/settings');

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const KARYAWAN = { id: 1, name: 'Ahmad Fauzi', shift_id: null };

// Scan mesin: log_state 0 = masuk, 1 = keluar.
function scans(tanggal, jam, denganKeluar = true) {
  const list = [{ log_time: tanggal + ' ' + jam + ':00', log_state: 0, verify_mode: 1, work_code: '1', device_user_id: '1' }];
  if (denganKeluar) {
    list.push({ log_time: tanggal + ' 17:30:00', log_state: 1, verify_mode: 1, work_code: '1', device_user_id: '1' });
  }
  return list;
}

function pengajuan(jenis) {
  return {
    leave_type: jenis,
    subtype: null,
    place: null,
    reason: 'Keperluan pribadi',
    start_date: arguments[1],
    end_date: arguments[1],
  };
}

const LUNAS = '2026-09-28'; // Senin lalu -> sudah lewat, harus dihitung alpa
const HARI_INI = '2026-10-03';

async function main() {
  const settings = await s.getAll({ refresh: true });
  att.invalidateGlobalShift();
  await s.getAll({ refresh: true });

  const kasus = [
    { nama: 'Scan tepat waktu (08:00)', tanggal: LUNAS, jam: '08:00' },
    { nama: 'Scan telat (08:45)', tanggal: LUNAS, jam: '08:45' },
    { nama: 'Scan sangat telat (10:00)', tanggal: LUNAS, jam: '10:00' },
    { nama: 'Hanya scan masuk (08:00)', tanggal: LUNAS, jam: '08:00', keluar: false },
    { nama: 'TANPA scan, tanpa pengajuan', tanggal: LUNAS },
    { nama: 'TANPA scan, ada izin', tanggal: LUNAS, izin: 'izin' },
    { nama: 'TANPA scan, ada sakit', tanggal: LUNAS, izin: 'sakit' },
    { nama: 'TANPA scan, ada cuti', tanggal: LUNAS, izin: 'cuti' },
    { nama: 'TANPA scan, dinas luar (GPS)', tanggal: LUNAS, dinas: true },
    { nama: 'Scan + ada izin (izin sebagian)', tanggal: LUNAS, jam: '08:00', izin: 'izin' },
    { nama: 'TANPA scan, hari ini sebelum cutoff', tanggal: HARI_INI },
    { nama: 'Sabtu (bukan hari kerja)', tanggal: '2026-10-03' },
    { nama: 'Minggu (bukan hari kerja)', tanggal: '2026-10-04' },
  ];

  console.log('SIMULASI STATUS ABSENSI - karyawan 001 (pakai Jam Kerja Global)');
  console.log('----------------------------------------------------------------');
  console.log('Pengaturan global_work_days : ' + settings.global_work_days + '  (Sen, Sel, Rab, Kam, Jum)');
  console.log('Hari tanpa scan diuji      : ' + LUNAS + ' (Senin, sudah lewat) dan ' + HARI_INI);
  console.log('');

  const rows = [];
  for (const k of kasus) {
    const resolved = await att.resolveShift(KARYAWAN.id, k.tanggal);
    const logs = k.jam ? scans(k.tanggal, k.jam, k.keluar !== false) : [];

    const duty = k.dinas
      ? { check_in_at: k.tanggal + ' 08:00:00', check_out_at: k.tanggal + ' 16:00:00', note: 'Bogor' }
      : null;

    const r = att.computeDaily({
      employee: KARYAWAN,
      workDate: k.tanggal,
      shift: resolved.shift,
      dayType: resolved.dayType,
      shiftSource: resolved.source,
      logs,
      leave: k.izin ? pengajuan(k.izin, k.tanggal) : null,
      duty,
      now: new Date(k.tanggal + 'T23:00:00'),
    });

    rows.push([
      k.nama,
      HARI[new Date(k.tanggal + 'T00:00:00').getDay()],
      r.status,
      r.firstIn ? String(r.firstIn).slice(11, 16) : '-',
      r.lateMinutes,
      r.workMinutes,
      r.overtimeMinutes,
    ]);
  }

  const headers = ['Kondisi', 'Hari', 'Status', 'Masuk', 'Telat', 'Kerja', 'Lembur'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(' | '));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  rows.forEach((r) => console.log(r.map((c, i) => String(c).padEnd(widths[i])).join(' | ')));

  const alpa = rows.filter((r) => r[2] === 'alpa').length;
  console.log('');
  console.log('Total kasus alpa (tanpa scan & tanpa pengajuan & hari kerja lewat): ' + alpa);

  await db.closePool();
}

main().catch(async (e) => {
  console.error('GAGAL:', e.message);
  try { await db.closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});