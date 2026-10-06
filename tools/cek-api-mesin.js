'use strict';

/**
 * Smoke test fitur "mesin fingerprint per karyawan" lewat HTTP.
 * Jalankan: node tools/cek-api-mesin.js
 */

const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/db/pool');
const { createApp } = require('../src/app');

function tokenFor(row) {
  return jwt.sign(
    {
      sub: row.id,
      username: row.username,
      role: row.role,
      name: row.full_name,
      employee_id: row.employee_id ?? null,
    },
    config.auth.jwtSecret,
    { expiresIn: '1h' }
  );
}

(async () => {
  const admin = await db.queryOne("SELECT * FROM app_users WHERE role = 'admin' LIMIT 1");
  if (!admin) throw new Error('Tidak ada akun admin. Jalankan npm run seed.');

  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");
  const created = await db.execute(
    "INSERT INTO devices (name, protocol, ip_address, port, location, is_active) VALUES ('UJI Mesin Kantor', 'zkteco-tcp', '10.7.7.7', 4370, 'Lobi Uji', 1)"
  );
  const deviceId = created.insertId;

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${tokenFor(admin)}` };

  const call = async (label, path, options = {}) => {
    const res = await fetch(base + path, {
      ...options,
      headers: { ...auth, 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    console.log(`${res.status} ${label} ->`, JSON.stringify(body).slice(0, 200));
    return { status: res.status, body };
  };

  const meta = await call('GET /api/auth/meta', '/api/auth/meta');
  const devices = (meta.body.data || {}).devices || [];
  console.log('   devices di meta:', devices.map((d) => `${d.id}:${d.name}`).join(', '));

  // Buat karyawan dengan mesin yang dipilih.
  const made = await call('POST /api/employees', '/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      employee_code: 'TST-API-MESIN',
      name: 'Uji Mesin API',
      device_user_id: '9971',
      device_id: deviceId,
    }),
  });
  const employeeId = made.body.data && made.body.data.data && made.body.data.data.id;
  const emp = made.body.data;
  const newId = emp && emp.id;
  console.log('   device_name di respons:', emp && emp.device_name);

  // Tolak mesin fiktif.
  await call('POST /api/employees (mesin fiktif)', '/api/employees', {
    method: 'POST',
    body: JSON.stringify({ employee_code: 'TST-API-X', name: 'X', device_id: 999999 }),
  });

  // Filter daftar berdasarkan mesin.
  const filtered = await call('GET /api/employees?device_id=' + deviceId, '/api/employees?device_id=' + deviceId);
  console.log('   karyawan terfilter:', (filtered.body.data || []).map((r) => r.employee_code).join(', '));

  // Ubah ke mesin kosong = boleh absen di semua mesin.
  if (newId) {
    await call('PUT /api/employees/' + newId + ' (kosongkan mesin)', '/api/employees/' + newId, {
      method: 'PUT',
      body: JSON.stringify({ device_id: null }),
    });
    await call('DELETE /api/employees/' + newId, '/api/employees/' + newId, { method: 'DELETE' });
  }

  await db.execute("DELETE FROM employees WHERE employee_code LIKE 'TST-API-%'");
  await db.execute("DELETE FROM devices WHERE name LIKE 'UJI %'");
  void employeeId;

  server.close();
  await db.closePool();
  process.exit(0);
})().catch(async (err) => {
  console.error('ERR', err.message);
  try {
    await db.closePool();
  } catch {
    /* abaikan */
  }
  process.exit(1);
});
