'use strict';

/**
 * Smoke test endpoint /api/holidays lewat HTTP.
 * Jalankan: node tools/cek-api-hari-libur.js
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

  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const auth = { authorization: `Bearer ${tokenFor(admin)}` };
  const call = async (label, path, options = {}) => {
    const res = await fetch(base + path, { ...options, headers: { ...auth, ...(options.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    console.log(`${res.status} ${label} ->`, JSON.stringify(body).slice(0, 220));
    return body;
  };

  await call('GET /api/holidays?year=2026', '/api/holidays?year=2026');
  await call('GET /api/holidays/upcoming?days=400', '/api/holidays/upcoming?days=400');

  const created = await call('POST /api/holidays', '/api/holidays', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holiday_date: '2027-06-15', name: 'Cuti Natal Perusahaan', kind: 'custom' }),
  });

  if (created.data && created.data.id) {
    await call('PUT /api/holidays/' + created.data.id, '/api/holidays/' + created.data.id, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_workday: 1 }),
    });
    await call('DELETE /api/holidays/' + created.data.id, '/api/holidays/' + created.data.id, { method: 'DELETE' });
  }

  await call('POST /api/holidays (duplikat ditolak)', '/api/holidays', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holiday_date: '2026-01-01', name: 'Duplikat', kind: 'custom' }),
  });

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
