'use strict';

/**
 * Uji akhir fitur "mesin fingerprint per karyawan".
 *
 * Membuat dua mesin sementara, menunjuk satu karyawan ke mesin A, lalu
 * menyuntik log dari mesin B untuk membuktikan rekap tetap dihitung hadir
 * dengan penanda "mesin lain".
 */

const db = require('../src/db/pool');
const employees = require('../src/services/employees');
const attendance = require('../src/services/attendance');

const TEST_DATE = '2026-06-08';

(async () => {
  // Buang sisa uji sebelumnya.
  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");

  const a = await db.execute(
    "INSERT INTO devices (name, protocol, ip_address, port, location, is_active) VALUES ('UJI Mesin A', 'zkteco-tcp', '10.0.0.1', 4370, 'Lobby', 1)"
  );
  const b = await db.execute(
    "INSERT INTO devices (name, protocol, ip_address, port, location, is_active) VALUES ('UJI Mesin B', 'zkteco-tcp', '10.0.0.2', 4370, 'Pabrik', 1)"
  );
  const deviceA = a.insertId;
  const deviceB = b.insertId;

  const employee = await db.queryOne("SELECT id, name FROM employees WHERE status = 'aktif' AND device_user_id IS NOT NULL LIMIT 1");
  if (!employee) throw new Error('Tidak ada karyawan dengan PIN untuk pengujian.');

  await db.execute('DELETE FROM attendance_logs WHERE employee_id = ? AND log_date = ?', [employee.id, TEST_DATE]);
  await db.execute('DELETE FROM attendance_daily WHERE employee_id = ? AND work_date = ?', [employee.id, TEST_DATE]);

  // 1) Karyawan tanpa mesin -> scan dari mesin mana pun tidak ditandai.
  await db.execute('UPDATE employees SET device_id = NULL WHERE id = ?', [employee.id]);
  await insertLog(employee.id, deviceB, TEST_DATE, '08:05:00', 0);
  await insertLog(employee.id, deviceB, TEST_DATE, '17:05:00', 1);
  let row = await rekap(employee.id, TEST_DATE);
  console.log('1) tanpa mesin -> status:', row.status, '| is_wrong_device:', row.is_wrong_device);

  // 2) Ditunjuk ke Mesin A, scan dari Mesin A -> normal.
  await db.execute('UPDATE employees SET device_id = ? WHERE id = ?', [deviceA, employee.id]);
  await db.execute('DELETE FROM attendance_logs WHERE employee_id = ? AND log_date = ?', [employee.id, TEST_DATE]);
  await insertLog(employee.id, deviceA, TEST_DATE, '08:05:00', 0);
  await insertLog(employee.id, deviceA, TEST_DATE, '17:05:00', 1);
  row = await rekap(employee.id, TEST_DATE);
  console.log('2) mesin sesuai -> status:', row.status, '| is_wrong_device:', row.is_wrong_device);

  // 3) Ditunjuk ke Mesin A, scan dari Mesin B -> tetap hadir, tapi ditandai.
  await db.execute('DELETE FROM attendance_logs WHERE employee_id = ? AND log_date = ?', [employee.id, TEST_DATE]);
  await insertLog(employee.id, deviceB, TEST_DATE, '08:30:00', 0);
  await insertLog(employee.id, deviceB, TEST_DATE, '17:00:00', 1);
  row = await rekap(employee.id, TEST_DATE);
  console.log('3) mesin lain -> status:', row.status, '| is_wrong_device:', row.is_wrong_device);
  console.log('   note:', row.note);
  console.log('   jam:', row.first_in, '->', row.first_out, '| kerja', row.work_minutes, 'mnt | telat', row.late_minutes);

  // 4) Detail harian melaporkan mesin yang dipakai scan.
  const detail = await attendance.getOne(employee.id, TEST_DATE);
  console.log('4) mesin ditunjuk:', JSON.stringify(detail.assigned_device));
  console.log('   mesin pada log:', JSON.stringify(detail.scan_devices));

  // 5) Validasi: device_id fiktif ditolak.
  try {
    await employees.assertDeviceExists(999999);
    console.log('5) device_id fiktif: TIDAK DITOLAK (bug)');
  } catch (err) {
    console.log('5) device_id fiktif ditolak:', err.message);
  }

  // Bersihkan.
  await db.execute('DELETE FROM attendance_logs WHERE employee_id = ? AND log_date = ?', [employee.id, TEST_DATE]);
  await db.execute('DELETE FROM attendance_daily WHERE employee_id = ? AND work_date = ?', [employee.id, TEST_DATE]);
  await db.execute('UPDATE employees SET device_id = NULL WHERE id = ?', [employee.id]);
  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");
  console.log('bersih.');

  await db.closePool();
  process.exit(0);
})().catch((err) => {
  console.error('ERR', err.message, err.stack);
  process.exit(1);
});

async function insertLog(employeeId, deviceId, date, time, state) {
  await db.execute(
    `INSERT INTO attendance_logs
       (device_id, employee_id, device_user_id, log_time, log_date, log_state, verify_mode, work_code, source)
     VALUES (?, ?, '1', ?, ?, ?, 0, '', 'sync')`,
    [deviceId, employeeId, `${date} ${time}`, date, state]
  );
}

async function rekap(employeeId, date) {
  await attendance.generate({ from: date, to: date, employeeId });
  return db.queryOne(
    'SELECT status, first_in, first_out, work_minutes, late_minutes, is_wrong_device, note FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employeeId, date]
  );
}
