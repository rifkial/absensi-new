'use strict';

/**
 * Backup & restore database khusus admin (tanpa mysqldump biner).
 *
 * Alasan tanpa mysqldump: XAMPP/Windows sering tidak menyediakan biner di PATH,
 * sedangkan dump JS murni lewat pool yang sama selalu tersedia. Hasilnya file
 * .sql berisi CREATE TABLE IF NOT EXISTS + INSERT per tabel (urutan aman FK),
 * bisa diunduh admin dan direstore ulang dari halaman Backup.
 *
 * Pengaman:
 * - Semua endpoint memakai permission 'backup:manage' (= role admin saja).
 * - Restore dikunci: hanya 1 proses jalan, wajib konfirmasi nama database,
 *   otomatis backup pra-restore, matikan scheduler sync selama restore.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../config');
const db = require('../db/pool');
const { badRequest } = require('../utils/errors');

let running = null;

function backupDir() {
  const dir = path.join(config.root, 'storage', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function backupPath(name) {
  return path.join(backupDir(), `${safeName(name)}.sql`);
}

function escapeValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (value instanceof Date) {
    return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`;
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

/** Daftar tabel user (tanpa view sistem information_schema). */
async function listTables() {
  const rows = await db.queryAll(
    'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = ? ORDER BY TABLE_NAME',
    ['BASE TABLE']
  );
  let names = rows.map((r) => r.name).filter(Boolean);
  // Urutan aman FK untuk restore: master dulu, transaksi belakangan.
  const priority = [
    'departments', 'positions', 'shifts', 'employees', 'app_users', 'devices',
    'holidays', 'schedules', 'settings', 'notification_templates',
    'attendance_logs', 'attendance_daily', 'leave_quotas', 'leave_requests',
    'reimburses', 'duty_checkins', 'notifications', 'audit_logs', 'sync_history',
  ];
  names = names.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return names;
}

async function buildDump() {
  const database = config.db.database;
  const tables = await listTables();
  const parts = [];
  parts.push('-- Backup database absensi');
  parts.push(`-- database: ${database}`);
  parts.push(`-- dibuat: ${new Date().toISOString()}`);
  parts.push('SET FOREIGN_KEY_CHECKS=0;');

  for (const table of tables) {
    const create = await db.queryOne('SHOW CREATE TABLE ??', [table]).catch(() => null);
    // SHOW CREATE TABLE tidak mendukung placeholder untuk nama tabel di semua driver,
    // jadi fallback ke query langsung dengan whitelist dari listTables().
    let createSql = create ? (create['Create Table'] || Object.values(create)[1]) : null;
    if (!createSql) {
      const rows = await db.queryAll(`SHOW CREATE TABLE \`${table}\``);
      createSql = rows[0] ? (rows[0]['Create Table'] || Object.values(rows[0])[1]) : null;
    }
    if (!createSql) continue;
    parts.push('');
    parts.push(`-- tabel: ${table}`);
    parts.push(`${String(createSql).replace(/CREATE TABLE `[^`]+`/, `CREATE TABLE IF NOT EXISTS \`${table}\``)};`);

    const count = await db.queryScalar(`SELECT COUNT(*) FROM \`${table}\``);
    if (!Number(count)) continue;
    // Baca per batch supaya tabel log besar tidak makan memori.
    const BATCH = 500;
    for (let offset = 0; ; offset += BATCH) {
      const rows = await db.queryAll(`SELECT * FROM \`${table}\` LIMIT ${BATCH} OFFSET ${offset}`);
      if (rows.length === 0) break;
      const cols = Object.keys(rows[0]).map((c) => `\`${c}\``).join(', ');
      for (const row of rows) {
        parts.push(`INSERT INTO \`${table}\` (${cols}) VALUES (${Object.values(row).map(escapeValue).join(', ')});`);
      }
      if (rows.length < BATCH) break;
    }
  }

  parts.push('');
  parts.push('SET FOREIGN_KEY_CHECKS=1;');
  parts.push('');
  return { sql: parts.join('\n'), tables };
}

async function pruneBackups(keep = 10) {
  const files = listBackups();
  const extra = files.slice(Math.max(1, keep));
  for (const file of extra) {
    try {
      fs.unlinkSync(backupPath(file.name.replace(/\.sql$/, '')));
    } catch {
      // abaikan
    }
  }
  return Math.max(0, files.length - Math.min(files.length, Math.max(1, keep)));
}

function listBackups() {
  const dir = backupDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      const full = path.join(dir, file);
      try {
        const stat = fs.statSync(full);
        return {
          name: file.replace(/\.sql$/, ''),
          file,
          size: stat.size,
          created_at: stat.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Buat backup baru: tulis ke storage/backups + kembalikan buffer unduhan.
 * Retensi otomatis: simpan BACKUP_KEEP terbaru (default 10).
 */
async function createBackup({ keep = config.backup.keep } = {}) {
  if (running) throw badRequest('Proses backup/restore masih berjalan. Tunggu selesai dulu.');
  running = { kind: 'backup', startedAt: new Date().toISOString() };
  try {
    const { sql, tables } = await buildDump();
    const name = `absensi-${config.db.database}-${stamp()}`;
    fs.writeFileSync(backupPath(name), sql, 'utf8');
    await pruneBackups(keep);
    return {
      name,
      file: `${name}.sql`,
      size: Buffer.byteLength(sql, 'utf8'),
      tables,
      rows: sql.split('\n').filter((l) => l.startsWith('INSERT INTO')).length,
    };
  } finally {
    running = null;
  }
}

/** Pecah .sql jadi statement aman (abaikan komentar + pisahkan di ';' akhir baris). */
function splitStatements(sql) {
  const text = String(sql || '').replace(/\r\n/g, '\n');
  const statements = [];
  let current = '';
  let inString = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      current += ch;
      if (ch === '\\' && next) {
        current += next;
        i += 1;
      } else if (ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '-' && next === '-' && text[i + 2] === ' ') {
      while (i < text.length && text[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }
    current += ch;
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') statements.push(trimmed);
      current = '';
    }
  }
  const rest = current.trim();
  if (rest && rest !== ';') statements.push(rest);
  return statements.filter((s) => s && !s.startsWith('SET FOREIGN_KEY_CHECKS'));
}

function assertBackupSql(sql) {
  const text = String(sql || '');
  if (text.length < 100) throw badRequest('File backup terlalu kecil / bukan dump .sql.');
  if (!/CREATE TABLE/i.test(text) || !/INSERT INTO/i.test(text)) {
    throw badRequest('File bukan dump backup absensi (wajib ada CREATE TABLE + INSERT INTO).');
  }
  if (text.length > 500 * 1024 * 1024) throw badRequest('File backup melebihi 500MB.');
  return text;
}

/**
 * Restore dari teks .sql. Wajib konfirmasi nama database.
 * Otomatis buat backup pra-restore + matikan scheduler sync selama proses.
 */
async function restoreFromSql(sql, { confirm, actor = null } = {}) {
  const expected = config.db.database;
  if (String(confirm || '').trim() !== expected) {
    throw badRequest(`Konfirmasi salah. Ketik persis nama database: ${expected}`);
  }
  if (running) throw badRequest('Proses backup/restore masih berjalan. Tunggu selesai dulu.');
  const text = assertBackupSql(sql);
  const statements = splitStatements(text);
  if (statements.length === 0) throw badRequest('Tidak ada statement SQL yang bisa dijalankan.');

  running = { kind: 'restore', startedAt: new Date().toISOString(), statements: statements.length };
  let preBackup = null;
  let syncWasRunning = false;
  try {
    // Jaring pengaman: backup otomatis sebelum data ditimpa.
    const { sql: preSql } = await buildDump();
    preBackup = `pre-restore-${stamp()}`;
    fs.writeFileSync(backupPath(preBackup), preSql, 'utf8');

    // Hentikan scheduler sync supaya tidak menulis saat tabel dikosongkan.
    try {
      const sync = require('./sync');
      syncWasRunning = Boolean(sync.status?.()?.enabled);
      sync.stopScheduler?.();
    } catch {
      // abaikan
    }

    const allowedTables = new Set(await listTables());
    const conn = await db.getPool().getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS=0');
      let executed = 0;
      let skipped = 0;
      const errors = [];
      const truncated = new Set();
      for (const stmt of statements) {
        const text = stmt.trim();
        // Hanya izinkan DDL/DML restore. Tolak statement berbahaya di luar dump.
        const allowed = /^(CREATE TABLE|INSERT INTO|REPLACE INTO|TRUNCATE TABLE|DELETE FROM|DROP TABLE|ALTER TABLE|SET |USE )/i.test(text);
        if (!allowed) {
          skipped += 1;
          continue;
        }
        const tableMatch = /^(?:INSERT INTO|REPLACE INTO|TRUNCATE TABLE|DELETE FROM|DROP TABLE|ALTER TABLE|CREATE TABLE)\s+`?([^`\s(]+)`?/i.exec(text);
        const tableName = tableMatch ? tableMatch[1] : null;
        if (tableName && !allowedTables.has(tableName)) {
          skipped += 1;
          continue;
        }
        // TRUNCATE sekali per tabel sebelum INSERT pertama, supaya restore
        // idempoten tanpa duplikat (dump memakai INSERT, bukan REPLACE).
        if (/^INSERT INTO/i.test(text) && tableName && !truncated.has(tableName)) {
          truncated.add(tableName);
          try {
            await conn.query(`TRUNCATE TABLE \`${tableName}\``);
            executed += 1;
          } catch (err) {
            errors.push(`TRUNCATE ${tableName}: ${err.message.slice(0, 150)}`);
          }
        }
        try {
          await conn.query(stmt);
          executed += 1;
        } catch (err) {
          errors.push(err.message.slice(0, 200));
          if (errors.length > 20) throw new Error(`Terlalu banyak error restore, dihentikan. Contoh: ${errors[0]}`);
        }
      }
      await conn.query('SET FOREIGN_KEY_CHECKS=1');
      return {
        executed,
        skipped,
        total: statements.length,
        preBackup: `${preBackup}.sql`,
        syncWasRunning,
        actor,
        warnings: errors.slice(0, 5),
      };
    } finally {
      try {
        await conn.query('SET FOREIGN_KEY_CHECKS=1');
      } catch {
        // abaikan
      }
      conn.release();
    }
  } finally {
    running = null;
    // Jangan nyalakan sync otomatis diam-diam; admin nyalakan manual bila perlu.
  }
}

function status() {
  return {
    database: config.db.database,
    running,
    backups: listBackups().length,
  };
}

module.exports = {
  backupDir,
  createBackup,
  listBackups,
  backupPath,
  restoreFromSql,
  assertBackupSql,
  splitStatements,
  listTables,
  status,
};
