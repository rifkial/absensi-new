'use strict';
/**
 * Cek status rekap yang tidak konsisten:
 * hari kerja yang sudah lewat tapi masih berstatus "belum".
 * Jalankan: node tools/cek-status-belum.js
 */
const db = require('../src/db/pool');

async function main() {
  console.log('STATUS REKAP HARIAN');
  console.log('--------------------');
  const dist = await db.queryAll(
    `SELECT status, COUNT(*) AS jml, MIN(work_date) AS dari, MAX(work_date) AS sampai
       FROM attendance_daily GROUP BY status ORDER BY status`
  );
  console.table(dist);

  console.log('BARIS "belum" PADA HARI YANG SUDAH LEWAT (seharusnya alpa)');
  console.log('------------------------------------------------------------');
  const sisa = await db.queryAll(
    `SELECT d.work_date, e.employee_code, e.name,
            (SELECT COUNT(*) FROM attendance_logs l
              WHERE l.device_user_id = e.device_user_id
                AND DATE(l.log_time) = d.work_date) AS jumlah_scan
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.status = 'belum'
        AND d.work_date < CURDATE()
      ORDER BY d.work_date, e.employee_code
      LIMIT 50`
  );

  if (sisa.length === 0) {
    console.log('  (tidak ada - semua hari kerja yang lewat sudah berstatus alpa)');
  } else {
    console.table(sisa);
    console.log('  Total: ' + sisa.length + ' baris. Jalankan "Regenerasi Rekap" di menu Shift & Jadwal');
    console.log('  atau mesin PENGATURAN -> Backfill Rekap untuk memperbaikinya.');
  }

  await db.closePool();
}

main().catch(async (e) => {
  console.error('GAGAL:', e.message);
  try { await db.closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});