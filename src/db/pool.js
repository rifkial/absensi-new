'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

/**
 * Pool koneksi yang dipakai seluruh aplikasi.
 * Lazy-dibuat supaya proses CLI (mis. migrate) tidak membuka koneksi sia-sia.
 */
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      // Antrean dibatasi: refresh spam langsung 503, bukan nunggu abadi
      // sampai browser timeout. Frontend retry 1x menutupinya.
      queueLimit: 50,
      connectTimeout: 5000,
      charset: config.db.charset,
      // Data absensi memakai waktu dinding (wall clock) lokal, bukan UTC.
      // Kolom DATE/DATETIME/TIMESTAMP dikembalikan sebagai string apa adanya
      // supaya tidak bergeser 7 jam saat dikirim ke browser sebagai JSON.
      dateStrings: ['DATE', 'DATETIME', 'TIMESTAMP'],
      timezone: 'local',
      multipleStatements: false,
      namedPlaceholders: false,
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Sama seperti query() tapi untuk INSERT/UPDATE/DELETE (mengembalikan result, bukan rows). */
async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

/**
 * Jalankan SQL panjang dengan banyak placeholder tanpa prepared statement.
 *
 * MariaDB/MySQL punya batas jumlah parameter pada prepared statement (65535).
 * INSERT multi-baris untuk rekap mingguan bisa melebihi batas itu dan memicu
 * "Malformed communication packet". Karena kueri sudah dibangun dari kode
 * (bukan input pengguna mentah), mode non-prepared di sini aman dan jauh
 * lebih tahan ukuran payload besar.
 *
 * `params` boleh berupa array biasa, atau object bila memakai namedPlaceholders.
 */
async function executeLarge(sql, params = []) {
  if (Array.isArray(params)) {
    const [result] = await getPool().query(sql, params);
    return result;
  }

  // Bentuk object named placeholder (mysql2 menyediakan namedParameterPlaceholders).
  const [result] = await getPool().query({
    sql,
    values: params,
    namedPlaceholders: true,
  });
  return result;
}

/** Ambil banyak baris. */
async function queryAll(sql, params = []) {
  return query(sql, params);
}

/** Ambil satu baris atau null. */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Ambil satu nilai kolom pertama dari hasil query. */
async function queryScalar(sql, params = []) {
  const row = await queryOne(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length > 0 ? row[keys[0]] : null;
}

/**
 * Jalankan `fn` di dalam transaksi. Rollback otomatis bila fn melempar error.
 * fn menerima objek connection (bukan pool), jadi panggil conn.execute().
 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // rollback gagal -> koneksi sudah tidak valid, akan dibuang oleh pool
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** Bangun klausa WHERE dari objek { kolom: nilai }, mengabaikan nilai null/undefined. */
function buildWhere(filters, startIndex = 0) {
  const params = [];
  const parts = [];

  Object.entries(filters).forEach(([column, value], index) => {
    if (value === null || value === undefined || value === '') return;

    if (Array.isArray(value)) {
      if (value.length === 0) return;
      const placeholders = value.map(() => '?').join(', ');
      parts.push(`${column} IN (${placeholders})`);
      params.push(...value);
      return;
    }

    if (value && typeof value === 'object' && 'op' in value) {
      const allowed = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'];
      const op = allowed.includes(value.op.toUpperCase()) ? value.op.toUpperCase() : '=';
      parts.push(`${column} ${op} ?`);
      params.push(value.value);
      return;
    }

    parts.push(`${column} = ?`);
    params.push(value);
    void index;
    void startIndex;
  });

  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Bangun klausa ORDER BY dari object { kolom: 'ASC'|'DESC' } dengan daftar kolom valid. */
function buildOrderBy(sort, allowedColumns, fallback) {
  if (!sort) return fallback;
  const entries = Object.entries(sort);
  if (entries.length === 0) return fallback;

  const parts = entries
    .filter(([column]) => allowedColumns.includes(column))
    .map(([column, direction]) => {
      const dir = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      return `${column} ${dir}`;
    });

  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : fallback;
}

async function testConnection() {
  const row = await queryOne('SELECT VERSION() AS version, DATABASE() AS db, NOW() AS now');
  return row;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  query,
  queryAll,
  queryOne,
  queryScalar,
  execute,
  executeLarge,
  transaction,
  buildWhere,
  buildOrderBy,
  testConnection,
  closePool,
};
