'use strict';

/**
 * Verifikasi integrasi hari libur ke rekap absensi.
 * Jalankan: node tools/cek-rekap-hari-libur.js
 */

const attendance = require('../src/services/attendance');
const holidays = require('../src/services/holidays');
const db = require('../src/db/pool');

(async () => {
  const employee = await db.queryOne("SELECT id, name FROM employees WHERE status <> 'resign' LIMIT 1");
  if (!employee) throw new Error('Tidak ada karyawan aktif.');

  // Hari kerja biasa (Senin, bukan libur) sebagai pembanding.
  const TEST_DATE = '2026-06-08';
  console.log(`rekap ${TEST_DATE} (Senin):`, JSON.stringify(
    await attendance.generate({ from: TEST_DATE, to: TEST_DATE, employeeId: employee.id })
  ));

  // Tanggal libur nasional 2026-01-01.
  console.log('rekap 2026-01-01 (libur nasional):', JSON.stringify(
    await attendance.generate({ from: '2026-01-01', to: '2026-01-01', employeeId: employee.id })
  ));

  const row = await db.queryOne(
    'SELECT work_date, status, note FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employee.id, '2026-01-01']
  );
  console.log('baris rekap:', JSON.stringify(row));

  // Tandai tanggal uji sebagai libur tambahan, lalu pastikan status berubah.
  const extra = await holidays.create({ holiday_date: TEST_DATE, name: 'Libur Uji Coba', kind: 'custom' });
  await attendance.generate({ from: TEST_DATE, to: TEST_DATE, employeeId: employee.id });
  const after = await db.queryOne(
    'SELECT work_date, status, note FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employee.id, TEST_DATE]
  );
  console.log('setelah ditandai libur:', JSON.stringify(after));

  // Tetapkan "tetap bekerja" -> harus kembali dihitung sebagai hari biasa.
  await holidays.update(extra.id, { is_workday: 1 });
  await attendance.generate({ from: TEST_DATE, to: TEST_DATE, employeeId: employee.id });
  const workday = await db.queryOne(
    'SELECT work_date, status, note FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employee.id, TEST_DATE]
  );
  console.log('setelah "tetap bekerja":', JSON.stringify(workday));

  await holidays.remove(extra.id);
  await db.closePool();
  process.exit(0);
})().catch((err) => {
  console.error('ERR', err.message, err.stack);
  process.exit(1);
});
