'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const config = require('../config');
const db = require('../db/pool');
const { unauthorized, forbidden, badRequest, notFound, conflict, asyncHandler, str } = require('../utils/errors');

/** Urutan hak akses dari tertinggi ke terendah. */
const ROLES = ['admin', 'hr', 'operator', 'viewer', 'employee'];

/** Peran yang hanya boleh melihat datanya sendiri lewat portal karyawan. */
const SELF_ROLES = ['employee'];

/** Hak akses per aksi. */
const PERMISSIONS = {
  'employees:read': ['admin', 'hr', 'operator', 'viewer'],
  'employees:write': ['admin', 'hr'],
  'employees:delete': ['admin'],
  'shifts:read': ['admin', 'hr', 'operator', 'viewer'],
  'shifts:write': ['admin', 'hr'],
  'holidays:read': ['admin', 'hr', 'operator', 'viewer'],
  // Menambah / mengubah hari libur memengaruhi rekap seluruh karyawan.
  'holidays:write': ['admin', 'hr'],
  'devices:read': ['admin', 'hr', 'operator'],
  'devices:write': ['admin'],
  'devices:sync': ['admin', 'hr', 'operator'],
  'attendance:read': ['admin', 'hr', 'operator', 'viewer'],
  'attendance:write': ['admin', 'hr', 'operator'],
  'reports:read': ['admin', 'hr', 'operator', 'viewer'],
  'reports:export': ['admin', 'hr', 'operator', 'viewer'],
  'users:manage': ['admin'],
  'settings:read': ['admin', 'hr'],
  'settings:write': ['admin'],
  'notify:send': ['admin', 'hr'],
  // Jejak audit memuat perubahan internal (termasuk siapa yang mengganti
  // password), jadi tidak dibuka untuk role read-only.
  'audit:read': ['admin', 'hr'],
  // Portal karyawan: hanya data miliknya sendiri.
  'self:read': ['admin', 'hr', 'employee'],
  'self:write': ['admin', 'hr', 'employee'],
};

function hashPassword(password) {
  return bcrypt.hash(password, config.auth.bcryptRounds);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      name: user.full_name,
      employee_id: user.employee_id ?? null,
    },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn }
  );
}

async function findUserByUsername(username) {
  return db.queryOne(
    `SELECT id, username, password_hash, full_name, role, employee_id, is_active
       FROM app_users WHERE username = ?`,
    [String(username).trim()]
  );
}

async function login(username, password) {
  const user = await findUserByUsername(username);

  // Selalu jalankan bcrypt, walau user tidak ada, supaya waktu respons tidak
  // membocorkan username mana yang terdaftar.
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const valid = await verifyPassword(password, hash);

  if (!user || !valid) {
    throw unauthorized('Username atau password salah.');
  }
  if (!user.is_active) {
    throw forbidden('Akun ini dinonaktifkan. Hubungi administrator.');
  }

  await db.execute('UPDATE app_users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  return {
    token: signToken(user),
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      employee_id: user.employee_id ?? null,
    },
  };
}

/** Middleware: wajib login. */
const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;

  if (!token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch (err) {
    throw unauthorized(
      err.name === 'TokenExpiredError' ? 'Sesi Anda habis. Silakan masuk kembali.' : 'Token tidak valid.'
    );
  }

  // Pastikan akun masih aktif (akun bisa dinonaktifkan saat sesi berjalan).
  const user = await db.queryOne(
    'SELECT id, username, full_name, role, employee_id, is_active FROM app_users WHERE id = ?',
    [payload.sub]
  );

  if (!user || !user.is_active) {
    throw unauthorized('Akun tidak ditemukan atau sudah dinonaktifkan.');
  }

  req.user = user;
  next();
});

/**
 * Middleware: wajib punya role 'employee' yang tertaut ke baris karyawan.
 * Menolak akun employee yang employee_id-nya sudah tidak ada / nonaktif,
 * supaya portal tidak menampilkan data orang lain.
 */
const requireSelf = asyncHandler(async (req, res, next) => {
  if (!req.user) throw unauthorized();

  if (req.user.role !== 'employee') {
    // Admin/HR boleh memakai endpoint ini untuk menguji, tapi wajib menyebut
    // employee_id secara eksplisit di query/body.
    return next();
  }

  if (!req.user.employee_id) {
    throw forbidden('Akun ini belum ditautkan ke data karyawan. Hubungi administrator.');
  }

  const employee = await db.queryOne(
    "SELECT id, name FROM employees WHERE id = ? AND status <> 'resign'",
    [req.user.employee_id]
  );

  if (!employee) {
    throw forbidden('Data karyawan tidak ditemukan atau sudah tidak aktif.');
  }

  req.employeeId = employee.id;
  next();
});

/**
 * Ambil employee_id yang sah untuk request ini.
 * Role employee selalu terkunci ke akunnya; peran lain harus menyebut
 * employee_id secara eksplisit (dipakai admin untuk melihat data karyawan).
 */
async function resolveSelfEmployeeId(req) {
  if (req.user.role === 'employee') return req.employeeId;

  const raw = req.query.employee_id ?? req.body?.employee_id ?? req.params.employeeId;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('employee_id wajib diisi untuk peran ini.');
  }
  return id;
}

/** Middleware: cek izin berdasarkan aksi. */
function requirePermission(action) {
  const allowed = PERMISSIONS[action];
  if (!allowed) {
    throw new Error(`Permission "${action}" belum didefinisikan.`);
  }

  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(forbidden(`Peran "${req.user.role}" tidak punya akses ke aksi ini.`));
    }
    next();
  };
}

/** Daftar akun pengguna (khusus admin). */
async function listUsers() {
  return db.queryAll(
    `SELECT u.id, u.username, u.full_name, u.role, u.employee_id, u.is_active,
            u.last_login_at, u.created_at,
            e.name AS employee_name, e.employee_code
       FROM app_users u
       LEFT JOIN employees e ON e.id = u.employee_id
      ORDER BY FIELD(u.role, 'admin', 'hr', 'operator', 'viewer', 'employee'), u.username`
  );
}

/**
 * Role 'employee' wajib tertaut ke satu karyawan. Vice versa, satu karyawan
 * hanya boleh punya satu akun portal (dijamin UNIQUE uq_app_users_employee).
 */
async function assertEmployeeLink(role, employeeId, excludeUserId = null) {
  if (role !== 'employee') {
    if (employeeId) throw badRequest('employee_id hanya boleh diisi untuk role "employee".');
    return;
  }

  if (!employeeId) {
    throw badRequest('employee_id wajib diisi untuk role "employee".');
  }

  const employee = await db.queryOne(
    'SELECT id, name, status FROM employees WHERE id = ?',
    [Number(employeeId)]
  );
  if (!employee) throw badRequest(`Karyawan dengan id ${employeeId} tidak ditemukan.`);
  if (employee.status === 'resign') {
    throw badRequest(`Karyawan "${employee.name}" sudah resign sehingga tidak bisa punya akun portal.`);
  }

  const taken = await db.queryOne(
    `SELECT id, username FROM app_users WHERE employee_id = ?${excludeUserId ? ' AND id <> ?' : ''}`,
    excludeUserId ? [Number(employeeId), excludeUserId] : [Number(employeeId)]
  );
  if (taken) {
    throw conflict(`Karyawan ini sudah punya akun portal ("${taken.username}").`);
  }
}

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.role, u.employee_id, u.is_active, u.created_at,
         e.name AS employee_name, e.employee_code
    FROM app_users u
    LEFT JOIN employees e ON e.id = u.employee_id
`;

async function createUser(payload, actorId = null) {
  const username = str(payload.username, { maxLength: 50 });
  const password = payload.password ? String(payload.password) : '';
  const fullName = str(payload.full_name, { maxLength: 100 });
  const role = str(payload.role, { maxLength: 20 }) || 'viewer';
  const employeeId = payload.employee_id ? Number(payload.employee_id) : null;

  if (!username) throw badRequest('username wajib diisi.');
  if (password.length < 8) {
    throw badRequest('Password minimal 8 karakter.');
  }
  if (!fullName) throw badRequest('full_name wajib diisi.');
  if (!ROLES.includes(role)) throw badRequest(`role tidak valid. Pilihan: ${ROLES.join(', ')}.`);
  if (payload.employee_id !== undefined && payload.employee_id !== null && !employeeId) {
    throw badRequest('employee_id harus berupa angka.');
  }

  const existing = await findUserByUsername(username);
  if (existing) throw conflict(`Username "${username}" sudah dipakai.`);

  await assertEmployeeLink(role, employeeId);

  const result = await db.execute(
    'INSERT INTO app_users (username, password_hash, full_name, role, employee_id) VALUES (?, ?, ?, ?, ?)',
    [username, await hashPassword(password), fullName, role, employeeId]
  );

  void actorId;
  return db.queryOne(`${USER_SELECT} WHERE u.id = ?`, [result.insertId]);
}

async function updateUser(id, payload) {
  const data = [];
  const params = [];

  const current = await db.queryOne('SELECT role, employee_id FROM app_users WHERE id = ?', [id]);
  if (!current) throw notFound('Pengguna tidak ditemukan.');

  if (payload.full_name !== undefined) {
    data.push('full_name = ?');
    params.push(str(payload.full_name, { maxLength: 100 }));
  }

  // Role & employee_id harus dievaluasi bersama karena keduanya saling terkait.
  if (payload.role !== undefined) {
    const role = str(payload.role, { maxLength: 20 });
    if (!ROLES.includes(role)) throw badRequest(`role tidak valid. Pilihan: ${ROLES.join(', ')}.`);
    data.push('role = ?');
    params.push(role);
  }

  if (payload.employee_id !== undefined) {
    data.push('employee_id = ?');
    params.push(payload.employee_id ? Number(payload.employee_id) : null);
  }

  const nextRole = payload.role !== undefined ? str(payload.role, { maxLength: 20 }) : current.role;
  const nextEmployeeId =
    payload.employee_id !== undefined
      ? payload.employee_id
        ? Number(payload.employee_id)
        : null
      : current.employee_id;

  if (payload.role !== undefined || payload.employee_id !== undefined) {
    await assertEmployeeLink(nextRole, nextEmployeeId, id);
  }

  if (payload.is_active !== undefined) {
    data.push('is_active = ?');
    params.push(payload.is_active ? 1 : 0);
  }
  if (payload.password) {
    const password = String(payload.password);
    if (password.length < 8) throw badRequest('Password minimal 8 karakter.');
    data.push('password_hash = ?');
    params.push(await hashPassword(password));
  }

  if (data.length === 0) throw badRequest('Tidak ada field yang diubah.');

  params.push(id);
  await db.execute(`UPDATE app_users SET ${data.join(', ')} WHERE id = ?`, params);

  return db.queryOne(`${USER_SELECT} WHERE u.id = ?`, [id]);
}



async function changeOwnPassword(userId, currentPassword, newPassword) {
  const user = await findUserByUsername(
    (await db.queryScalar('SELECT username FROM app_users WHERE id = ?', [userId])) || ''
  );
  if (!user) throw unauthorized('Akun tidak ditemukan.');

  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) throw forbidden('Password saat ini salah.');

  if (String(newPassword).length < 8) throw forbidden('Password baru minimal 8 karakter.');

  await db.execute('UPDATE app_users SET password_hash = ? WHERE id = ?', [
    await hashPassword(String(newPassword)),
    userId,
  ]);

  return { ok: true, message: 'Password berhasil diganti.' };
}

module.exports = {
  ROLES,
  SELF_ROLES,
  PERMISSIONS,
  hashPassword,
  verifyPassword,
  signToken,
  login,
  findUserByUsername,
  requireAuth,
  requirePermission,
  requireSelf,
  resolveSelfEmployeeId,
  listUsers,
  createUser,
  updateUser,
  changeOwnPassword,
};
