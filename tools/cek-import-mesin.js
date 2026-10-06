'use strict';

/**
 * Uji impor CSV karyawan dengan kolom device_id.
 * device_id boleh diisi id angka ATAU nama mesin.
 */

const db = require('../src/db/pool');
const employees = require('../src/services/employees');

(async () => {
  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");
  const created = await db.execute(
    "INSERT INTO devices (name, protocol, ip_address, port, location, is_active) VALUES ('UJI Kantor Pusat', 'zkteco-tcp', '10.9.9.9', 4370, 'Lobby', 1)"
  );
  const deviceId = created.insertId;

  // 1) Device id berupa nama mesin.
  const byName = [
    ['employee_code', 'device_user_id', 'device_id', 'name'],
    ['TST-UJI1', '9987', 'UJI Kantor Pusat', 'Uji Nama Mesin'],
  ];
  console.log('1) impor pakai nama mesin:', JSON.stringify(await employees.importFromRows(byName)));
  const row1 = await db.queryOne('SELECT device_id FROM employees WHERE employee_code = ?', ['TST-UJI1']);
  console.log('   device_id tersimpan:', row1 && row1.device_id, '(harusnya ' + deviceId + ')');

  // 2) Device id berupa angka.
  const byId = [
    ['employee_code', 'device_user_id', 'device_id', 'name'],
    ['TST-UJI2', '9988', String(deviceId), 'Uji Id Mesin'],
  ];
  console.log('2) impor pakai id angka:', JSON.stringify(await employees.importFromRows(byId)));
  const row2 = await db.queryOne('SELECT device_id FROM employees WHERE employee_code = ?', ['TST-UJI2']);
  console.log('   device_id tersimpan:', row2 && row2.device_id);

  // 3) Nama mesin yang tidak ada harus dilaporkan per baris.
  const bad = [
    ['employee_code', 'device_user_id', 'device_id', 'name'],
    ['TST-UJI3', '9989', 'Mesin Hantu', 'Uji Mesin Hantu'],
  ];
  const result = await employees.importFromRows(bad);
  console.log('3) mesin tidak ada ->', JSON.stringify(result));

  // 4) device_id kosong = boleh absen di semua mesin.
  const kosong = [
    ['employee_code', 'device_user_id', 'device_id', 'name'],
    ['TST-UJI4', '9990', '', 'Uji Tanpa Mesin'],
  ];
  console.log('4) device_id kosong:', JSON.stringify(await employees.importFromRows(kosong)));
  const row4 = await db.queryOne('SELECT device_id FROM employees WHERE employee_code = ?', ['TST-UJI4']);
  console.log('   device_id tersimpan:', row4 && row4.device_id, '(harus null)');

  await db.execute("DELETE FROM employees WHERE employee_code LIKE 'TST-UJI%'");
  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");
  console.log('bersih.');
  await db.closePool();
  process.exit(0);
})().catch((err) => {
  console.error('ERR', err.message, err.stack);
  process.exit(1);
});
