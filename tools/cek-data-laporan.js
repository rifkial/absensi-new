'use strict';
/**
 * Menampilkan data absensi yang dipakai laporan, langsung dari database.
 * Jalankan: node tools/cek-data-laporan.js
 */
const db = require('../src/db/pool');
const reports = require('../src/services/reports');

const FROM = '2026-09-03';
const TO = '2026-09-30';
const MONTH = '2026-09';

function pad(s, n) {
  s = String(s === null || s === undefined ? '-' : s);
  return s.length > n ? s.slice(0, n - 1) + '.' : s.padEnd(n);
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(line(headers));
  console.log(sep);
  rows.forEach((r) => console.log(line(r)));
  console.log('');
}

async function main() {
  console.log('='.repeat(78));
  console.log('  PEMERIKSAAN DATA LAPORAN ABSENSI');
  console.log('='.repeat(78));
  console.log('');

  // 1. Ringkasan isi tabel
  const counts = await db.queryAll(`
    SELECT
      (SELECT COUNT(*) FROM employees)                                        AS karyawan,
      (SELECT COUNT(*) FROM attendance_daily)                                 AS rekap_harian,
      (SELECT COUNT(*) FROM attendance_logs)                                  AS log_mesin,
      (SELECT COUNT(*) FROM departments)                                      AS unit_kerja,
      (SELECT MIN(work_date) FROM attendance_daily)                           AS tanggal_awal,
      (SELECT MAX(work_date) FROM attendance_daily)                           AS tanggal_akhir
  `);
  console.log('1. ISI TABEL');
  console.log('----------------');
  Object.entries(counts[0]).forEach(([k, v]) => console.log('   ' + pad(k, 16) + ': ' + v));
  console.log('');

  // 2. Sebaran status per hari (ringkasan)
  const ring = await reports.build('ringkasan', { from: FROM, to: TO });
  console.log('2. RINGKASAN PER HARI (' + FROM + ' s/d ' + TO + ')');
  console.log('-----------------------------------------------');
  table(
    ['Tanggal', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Cuti', 'Dinas', 'Alpa', 'Libur', 'Total'],
    ring.rows.slice(0, 12).map((r) => [
      r.work_date,
      r.hadir,
      r.telat,
      r.izin ?? 0,
      r.sakit ?? 0,
      r.cuti ?? 0,
      r.dinas_luar ?? 0,
      r.alpa ?? 0,
      r.hari_libur ?? 0,
      r.total,
    ])
  );
  if (ring.rows.length > 12) console.log('   ... (' + (ring.rows.length - 12) + ' hari lainnya)');
  console.log('   Total baris ringkasan: ' + ring.rows.length + ' hari');
  console.log('');

  // 3. Rekap kehadiran (format default halaman Laporan)
  const recap = await reports.build('rekap_kehadiran', { from: FROM, to: TO });
  console.log('3. REKAP KEHADIRAN KARYAWAN (format default)');
  console.log('----------------------------------------------');
  table(
    ['No', 'Kode', 'Nama', 'Unit Kerja', 'Hari', 'Hadir', 'Izin', 'Cuti', 'Dinas', 'Telat', 'Lembur(jam)'],
    recap.rows.map((r, i) => [
      i + 1,
      r.employee_code,
      r.employee_name,
      r.department_name,
      r.total_hari_kerja,
      r.total_hadir,
      r.total_izin,
      r.total_cuti,
      r.total_dinas_luar,
      r.total_hari_terlambat,
      r.total_lembur_jam,
    ])
  );
  console.log('   Baris: ' + recap.rows.length + '   (meta.total = ' + recap.meta.total + ')');
  console.log('');

  // 4. Rekap bulanan
  const monthly = await reports.build('rekap_bulanan', { month: MONTH });
  console.log('4. REKAP BULANAN (' + MONTH + ')');
  console.log('-----------------------------');
  table(
    ['Kode', 'Nama', 'Hari', 'Hadir', 'Telat', 'Izin', 'Sakit', 'Cuti', 'Alpa', '%Hadir', 'Kerja(jam)', 'Lembur(jam)'],
    monthly.rows.map((r) => [
      r.employee_code,
      r.employee_name,
      r.total_days,
      r.total_hadir,
      r.total_telat,
      r.total_izin,
      r.total_sakit,
      r.total_cuti,
      r.total_alpa,
      r.persen_hadir,
      r.total_kerja_jam,
      r.total_lembur_jam,
    ])
  );
  console.log('');

  // 5. Cek konsistensi antar tabel
  const cek = await db.queryAll(`
    SELECT
      d.work_date, d.status, COUNT(*) AS jml,
      SUM(CASE WHEN d.first_in IS NULL AND d.status IN ('hadir','telat') THEN 1 ELSE 0 END) AS hadir_tanpa_masuk,
      SUM(d.late_minutes) AS menit_telat, SUM(d.work_minutes) AS menit_kerja, SUM(d.overtime_minutes) AS menit_lembur
    FROM attendance_daily d
    WHERE d.work_date BETWEEN ? AND ?
    GROUP BY d.work_date, d.status
    ORDER BY d.work_date, d.status
  `, [FROM, TO]);

  const masalah = [];
  cek.filter((r) => r.hadir_tanpa_masuk > 0).forEach((r) =>
    masalah.push(r.work_date + ' status=' + r.status + ': ' + r.hadir_tanpa_masuk + ' baris hadir/telat tanpa jam masuk'));
  cek.filter((r) => Number(r.menit_kerja) < 0 || Number(r.menit_lembur) < 0 || Number(r.menit_telat) < 0)
    .forEach((r) => masalah.push(r.work_date + ' status=' + r.status + ': ada nilai durasi negatif'));

  const scanTanpaKaryawan = await db.queryAll(`
    SELECT COUNT(*) AS jml FROM attendance_logs l
    LEFT JOIN employees e ON e.device_user_id = l.device_user_id
    WHERE l.log_time BETWEEN ? AND ? AND e.id IS NULL
  `, [FROM + ' 00:00:00', TO + ' 23:59:59']);

  console.log('5. CONSISTENSI DATA');
  console.log('-------------------');
  console.log('   Scan mesin tanpa master karyawan: ' + (scanTanpaKaryawan[0] ? scanTanpaKaryawan[0].jml : 0));
  console.log('  -groups baris rekap diperiksa   : ' + cek.length);
  if (masalah.length === 0) {
    console.log('   Tidak ada anomali.');
  } else {
    console.log('   Anomali (' + masalah.length + '):');
    masalah.slice(0, 15).forEach((m) => console.log('     - ' + m));
    if (masalah.length > 15) console.log('     ... (' + (masalah.length - 15) + ' lainnya)');
  }

  await db.closePool();
}

main().catch(async (e) => {
  console.error('GAGAL:', e.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});