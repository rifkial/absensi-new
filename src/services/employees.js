'use strict';

const db = require('../db/pool');
const leaveQuota = require('./leaveQuota');
const { badRequest, notFound, conflict, str, boolParam, pagination, pageMeta } = require('../utils/errors');
const { toDate } = require('../utils/date');

const SELECT_COLUMNS = `
  e.id, e.employee_code, e.device_user_id, e.name, e.gender,
  e.department_id, e.position_id, e.shift_id, e.phone, e.email, e.address,
  e.photo_path, e.hire_date, e.status, e.fingerprint_status, e.notes,
  e.annual_leave_quota, e.annual_leave_used, e.annual_leave_reset_at,
  e.created_at, e.updated_at,
  dep.name AS department_name,
  pos.name AS position_name,
  s.code AS shift_code, s.name AS shift_name,
  s.start_time, s.end_time, s.late_tolerance_min, s.work_days
`;

const BASE_FROM = `
  FROM employees e
  LEFT JOIN departments dep ON dep.id = e.department_id
  LEFT JOIN positions   pos ON pos.id = e.position_id
  LEFT JOIN shifts      s   ON s.id = e.shift_id
`;

/**
 * Daftar karyawan dengan filter, sorting, dan paginasi.
 * Mendukung pencarian bebas di kode, nama, PIN, dan email.
 */
async function list(query = {}) {
  const { page, perPage, offset } = pagination(query);

  const where = [];
  const params = [];

  const search = str(query.search ?? query.q, { maxLength: 100 });
  if (search) {
    where.push('(e.name LIKE ? OR e.employee_code LIKE ? OR e.device_user_id LIKE ? OR e.email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const status = str(query.status, { maxLength: 20 });
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }

  const departmentId = query.department_id;
  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }

  const shiftId = query.shift_id;
  if (shiftId) {
    where.push('e.shift_id = ?');
    params.push(Number(shiftId));
  }

  const fingerprintStatus = str(query.fingerprint_status, { maxLength: 20 });
  if (fingerprintStatus) {
    where.push('e.fingerprint_status = ?');
    params.push(fingerprintStatus);
  }

  // Filter "sudah punya PIN mesin" / "belum"
  if (boolParam(query.has_device_user_id) === true) where.push("e.device_user_id IS NOT NULL AND e.device_user_id <> ''");
  if (boolParam(query.has_device_user_id) === false) where.push("(e.device_user_id IS NULL OR e.device_user_id = '')");

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const allowedSort = ['name', 'employee_code', 'department_name', 'status', 'hire_date', 'created_at', 'id'];
  const sortColumn = allowedSort.includes(query.sort_by) ? query.sort_by : 'name';
  const sortDir = String(query.sort_dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const total = await db.queryScalar(`SELECT COUNT(*) ${BASE_FROM} ${whereSql}`, params);

  const rows = await db.queryAll(
    `SELECT ${SELECT_COLUMNS} ${BASE_FROM} ${whereSql}
      ORDER BY ${sortColumn} ${sortDir}, e.id ASC
      LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  return { data: rows, meta: pageMeta(total, { page, perPage }) };
}

async function getById(id) {
  const row = await db.queryOne(`SELECT ${SELECT_COLUMNS} ${BASE_FROM} WHERE e.id = ?`, [id]);
  return row;
}

async function getByDeviceUserId(deviceUserId) {
  return db.queryOne(
    `SELECT ${SELECT_COLUMNS} ${BASE_FROM} WHERE e.device_user_id = ?`,
    [String(deviceUserId).trim()]
  );
}

async function getOrFail(id) {
  const row = await getById(id);
  if (!row) throw notFound(`Karyawan dengan id ${id} tidak ditemukan.`);
  return row;
}

/**
 * Normalisasi & validasi input karyawan.
 * PIN mesin dibatasi 50 karakter (mesin biasanya hanya muat 9 karakter).
 */
function normalize(payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.employee_code !== undefined) {
    const code = str(payload.employee_code, { maxLength: 30 });
    if (!code) throw badRequest('employee_code (NIK/kode karyawan) wajib diisi.');
    data.employee_code = code;
  }

  if (payload.device_user_id !== undefined) {
    const pin = str(payload.device_user_id, { maxLength: 50 });
    data.device_user_id = pin === '' ? null : pin;
  }

  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 120 });
    if (!name) throw badRequest('name (nama karyawan) wajib diisi.');
    data.name = name;
  }

  if (payload.gender !== undefined) {
    const gender = str(payload.gender, { maxLength: 1 });
    if (gender && !['L', 'P'].includes(gender.toUpperCase())) {
      throw badRequest("gender harus 'L' atau 'P'.");
    }
    data.gender = gender ? gender.toUpperCase() : null;
  }

  for (const [field, column] of [
    ['department_id', 'department_id'],
    ['position_id', 'position_id'],
    ['shift_id', 'shift_id'],
  ]) {
    if (payload[field] !== undefined) {
      const value = payload[field];
      data[column] = value === '' || value === null ? null : Number(value);
      if (data[column] !== null && !Number.isInteger(data[column])) {
        throw badRequest(`${field} harus berupa angka.`);
      }
    }
  }

  if (payload.phone !== undefined) data.phone = str(payload.phone, { maxLength: 25 }) || null;
  if (payload.email !== undefined) data.email = str(payload.email, { maxLength: 120 }) || null;
  if (payload.address !== undefined) data.address = str(payload.address, { maxLength: 255 }) || null;
  if (payload.photo_path !== undefined) data.photo_path = str(payload.photo_path, { maxLength: 255 }) || null;
  if (payload.notes !== undefined) data.notes = str(payload.notes, { maxLength: 2000 }) || null;

  // Jatah cuti tahunan. `annual_leave_used` sengaja tidak bisa diisi dari
  // form: angka terpakai hanya boleh berubah lewat persetujuan pengajuan atau
  // reset admin/HR (lihat services/leaveQuota.js).
  if (payload.annual_leave_quota !== undefined) {
    data.annual_leave_quota = normalizeQuota(payload.annual_leave_quota);
  }

  if (payload.hire_date !== undefined) {
    data.hire_date = payload.hire_date ? toDate(payload.hire_date) : null;
    if (payload.hire_date && !data.hire_date) throw badRequest('hire_date tidak valid (format YYYY-MM-DD).');
  }

  if (payload.status !== undefined) {
    const status = str(payload.status, { maxLength: 20 });
    if (!['aktif', 'nonaktif', 'resign'].includes(status)) {
      throw badRequest("status harus 'aktif', 'nonaktif', atau 'resign'.");
    }
    data.status = status;
  }

  if (payload.fingerprint_status !== undefined) {
    const fp = str(payload.fingerprint_status, { maxLength: 20 });
    if (!['belum', 'terdaftar', 'gagal'].includes(fp)) {
      throw badRequest("fingerprint_status harus 'belum', 'terdaftar', atau 'gagal'.");
    }
    data.fingerprint_status = fp;
  }

  return data;
}

/**
 * Validasi jatah cuti tahunan dari form.
 * Kosong berarti 0 (karyawan tanpa jatah cuti tahunan).
 */
function normalizeQuota(value) {
  if (value === '' || value === null || value === undefined) return 0;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw badRequest('annual_leave_quota harus bilangan bulat 0-365.');
  }
  if (parsed < 0 || parsed > leaveQuota.MAX_QUOTA_DAYS) {
    throw badRequest(`annual_leave_quota harus antara 0 dan ${leaveQuota.MAX_QUOTA_DAYS} hari.`);
  }
  return parsed;
}

/** Pastikan kode karyawan & PIN unik sebelum insert. */
async function assertUnique(employeeCode, deviceUserId, excludeId = null) {
  const rows = await db.queryAll(
    `SELECT id, employee_code, device_user_id
       FROM employees
      WHERE (employee_code = ? ${excludeId ? 'AND id <> ?' : ''})
         OR (device_user_id IS NOT NULL AND device_user_id = ? ${excludeId ? 'AND id <> ?' : ''})`,
    excludeId ? [employeeCode, excludeId, deviceUserId, excludeId] : [employeeCode, deviceUserId]
  );

  for (const row of rows) {
    if (row.employee_code === employeeCode) {
      throw conflict(`Kode karyawan "${employeeCode}" sudah dipakai oleh karyawan lain.`);
    }
    if (deviceUserId && row.device_user_id === deviceUserId) {
      throw conflict(`PIN mesin "${deviceUserId}" sudah dipakai oleh karyawan lain.`);
    }
  }
}

async function create(payload) {
  const data = normalize(payload);
  if (!data.device_user_id) delete data.device_user_id;
  data.status = data.status || 'aktif';
  data.fingerprint_status = data.fingerprint_status || 'belum';

  await assertUnique(data.employee_code, data.device_user_id || null);

  const columns = Object.keys(data);
  const result = await db.execute(
    `INSERT INTO employees (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => data[c])
  );

  return getById(result.insertId);
}

async function update(id, payload, { actorId = null } = {}) {
  await getOrFail(id);
  const data = normalize(payload, { partial: true });

  // Jatah cuti ditangani terpisah supaya "terpakai" ikut dijepit ke jatah baru
  // dan perubahannya tercatat di leave_quota_logs.
  const quota = data.annual_leave_quota;
  delete data.annual_leave_quota;

  if (Object.keys(data).length === 0 && quota === undefined) {
    throw badRequest('Tidak ada field yang diubah.');
  }

  // Kombinasi kode + PIN baru harus tetap unik.
  const current = await db.queryOne('SELECT employee_code, device_user_id FROM employees WHERE id = ?', [id]);
  const nextCode = data.employee_code ?? current.employee_code;
  const nextPin = data.device_user_id !== undefined ? data.device_user_id : current.device_user_id;
  if (data.employee_code !== undefined || data.device_user_id !== undefined) {
    await assertUnique(nextCode, nextPin || null, id);
  }

  // Ubah status enrollment sidik jari jadi "belum" bila PIN berubah.
  if (data.device_user_id && data.device_user_id !== current.device_user_id) {
    data.fingerprint_status = 'belum';
  }

  const columns = Object.keys(data);
  if (columns.length > 0) {
    await db.execute(
      `UPDATE employees SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => data[c]), id]
    );
  }

  if (quota !== undefined) {
    await leaveQuota.setQuota(id, quota, {
      actorId,
      reason: 'Perubahan jatah cuti tahunan dari form karyawan',
    });
  }

  return getById(id);
}

async function remove(id) {
  const employee = await getOrFail(id);

  // Jangan hapus karyawan yang punya log absensi; nonaktifkan saja supaya
  // riwayat laporan tetap utuh.
  const logCount = await db.queryScalar('SELECT COUNT(*) FROM attendance_logs WHERE employee_id = ?', [id]);
  if (Number(logCount) > 0) {
    await db.execute("UPDATE employees SET status = 'resign' WHERE id = ?", [id]);
    return {
      deleted: false,
      archived: true,
      employee,
      message: `Karyawan memiliki ${logCount} log absensi sehingga tidak dihapus, dengan ditandai "resign".`,
    };
  }

  await db.execute('DELETE FROM employees WHERE id = ?', [id]);
  return { deleted: true, archived: false, employee, message: 'Karyawan dihapus.' };
}

/** Statistik ringkas untuk dashboard / form. */
async function stats() {
  const row = await db.queryOne(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'aktif') AS aktif,
       SUM(status = 'nonaktif') AS nonaktif,
       SUM(status = 'resign') AS resign,
       SUM(device_user_id IS NOT NULL AND device_user_id <> '') AS punya_pin,
       SUM(fingerprint_status = 'terdaftar') AS fp_terdaftar
     FROM employees`
  );
  return row || {};
}

/**
 * Template CSV kosong untuk impor karyawan massal.
 * Urutannya mengikuti parseCsv di adapter CSV.
 */
const EMPLOYEE_CSV_TEMPLATE = [
  'employee_code,device_user_id,name,gender,department_id,position_id,shift_id,phone,email,hire_date,status,annual_leave_quota',
  '001,1,Ahmad Fauzi,L,1,1,1,081234567890,ahmad@contoh.com,2024-01-15,aktif,12',
  '002,2,Siti Aminah,P,1,2,2,081234567891,siti@contoh.com,2024-02-01,aktif,12',
].join('\n');

/** Impor karyawan dari array baris CSV (dipakai oleh endpoint /api/employees/import). */
async function importFromRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest('Tidak ada baris data untuk diimpor.');
  }

  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const columnIndex = (names) => header.findIndex((h) => names.includes(h));

  const idx = {
    employee_code: columnIndex(['employee_code', 'kode', 'nik', 'no']),
    device_user_id: columnIndex(['device_user_id', 'pin', 'userid', 'user id']),
    name: columnIndex(['name', 'nama']),
    gender: columnIndex(['gender', 'jk', 'jenis_kelamin']),
    department_id: columnIndex(['department_id', 'departemen', 'dept', 'departemen_id']),
    position_id: columnIndex(['position_id', 'jabatan', 'posisi']),
    shift_id: columnIndex(['shift_id', 'shift']),
    phone: columnIndex(['phone', 'telepon', 'hp', 'no_hp', 'telp']),
    email: columnIndex(['email', 'email_address', 'surel']),
    hire_date: columnIndex(['hire_date', 'tanggal_masuk', 'tgl_masuk']),
    status: columnIndex(['status']),
    annual_leave_quota: columnIndex([
      'annual_leave_quota',
      'jatah_cuti',
      'jatah cuti',
      'cuti_tahunan',
      'kuota_cuti',
    ]),
  };

  if (idx.name === -1) {
    throw badRequest('Kolom "name" / "nama" wajib ada pada file impor karyawan.');
  }
  if (idx.employee_code === -1) {
    throw badRequest('Kolom "employee_code" / "nik" / "kode" wajib ada pada file impor karyawan.');
  }

  let created = 0;
  let updated = 0;
  const errors = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.every((c) => String(c ?? '').trim() === '')) continue;

    const get = (key) => (idx[key] >= 0 ? String(row[idx[key]] ?? '').trim() : '');

    const payload = {
      employee_code: get('employee_code'),
      name: get('name'),
      device_user_id: get('device_user_id') || undefined,
      gender: get('gender') || undefined,
      phone: get('phone') || undefined,
      email: get('email') || undefined,
      hire_date: get('hire_date') || undefined,
      status: get('status') || undefined,
      annual_leave_quota: get('annual_leave_quota') || undefined,
    };
    for (const key of ['department_id', 'position_id', 'shift_id']) {
      const value = get(key);
      payload[key] = value === '' ? undefined : value;
    }

    try {
      const existing = await db.queryOne('SELECT id FROM employees WHERE employee_code = ?', [payload.employee_code]);
      if (existing) {
        await update(existing.id, payload, { actorId: null });
        updated += 1;
      } else {
        await create(payload);
        created += 1;
      }
    } catch (err) {
      errors.push({ baris: i + 1, pesan: err.message });
    }
  }

  return { total: rows.length - 1, created, updated, failed: errors.length, errors: errors.slice(0, 50) };
}

module.exports = {
  list,
  getById,
  getOrFail,
  getByDeviceUserId,
  create,
  update,
  remove,
  stats,
  importFromRows,
  normalize,
  normalizeQuota,
  EMPLOYEE_CSV_TEMPLATE,
};
