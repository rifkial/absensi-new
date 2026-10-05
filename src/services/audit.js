'use strict';

/**
 * Jejak audit untuk perubahan data sensitif.
 *
 * Tabel `audit_logs` sudah ada di skema sejak awal, tetapi belum pernah diisi.
 * Modul ini mengisinya untuk tindakan yang dampaknya besar: koreksi rekap
 * absensi, persetujuan pengajuan, ubah/hapus master data, dan perubahan
 * pengaturan.
 *
 * Prinsip penting: pencatatan audit TIDAK BOLEH menggagalkan operasi utama.
 * Semua penulisan dibungkus try/catch dan kegagalannya hanya dicatat ke
 * console, supaya masalah audit tidak pernah menyebabkan transaksi bisnis
 * gagal di tengah jalan.
 */

const db = require('../db/pool');

/** Panjang maksimum kolom entity_id / detail sebelum dipotong. */
const MAX_ENTITY_ID = 60;
const MAX_DETAIL = 4000;

/**
 * Nilai yang tidak boleh masuk ke audit log.
 * Password, token, dan hash tidak pernah dicatat, bahkan di dalam diff.
 */
const SECRET_KEYS = new Set([
  'password',
  'password_hash',
  'new_password',
  'current_password',
  'token',
  'auth_token',
  'push_auth_token',
  'secret',
  'jwt_secret',
  'pass',
  'mail_pass',
  'whatsapp_token',
  'api_key',
]);

function maskValue(value) {
  if (value === null || value === undefined) return null;
  return '***';
}

/**
 * Bersihkan objek agar aman disimpan: buang kunci rahasia dan potong teks
 * yang terlalu panjang supaya kolom TEXT tidak penuh.
 */
function sanitize(input) {
  if (input === null || input === undefined) return null;

  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (SECRET_KEYS.has(lower)) {
      clean[key] = maskValue(value);
      continue;
    }
    if (value === null || value === undefined) {
      clean[key] = value;
    } else if (typeof value === 'object') {
      clean[key] = JSON.stringify(value).slice(0, 500);
    } else {
      clean[key] = String(value).slice(0, 500);
    }
  }

  return JSON.stringify(clean).slice(0, MAX_DETAIL);
}

/**
 * Tulis satu baris audit.
 *
 * @param {object} entry
 * @param {number|null} entry.userId  Admin/HR yang melakukan perubahan.
 * @param {string} entry.action       Nama aksi, mis. 'attendance.override'.
 * @param {string} [entry.entity]     Nama tabel/entitas, mis. 'employees'.
 * @param {string|number} [entry.entityId]
 * @param {object|string} [entry.detail]  Konteks perubahan (otomatis disanitasi).
 * @param {string} [entry.ip]
 * @returns {Promise<boolean>} true bila berhasil ditulis.
 */
async function record({ userId = null, action, entity = null, entityId = null, detail = null, ip = null } = {}) {
  if (!action) return false;

  try {
    await db.execute(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, detail, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        String(action).slice(0, 60),
        entity ? String(entity).slice(0, 60) : null,
        entityId === null || entityId === undefined ? null : String(entityId).slice(0, MAX_ENTITY_ID),
        typeof detail === 'string' ? detail.slice(0, MAX_DETAIL) : sanitize(detail),
        ip ? String(ip).slice(0, 45) : null,
      ]
    );
    return true;
  } catch (err) {
    // Jangan pernah menggagalkan operasi bisnis karena audit.
    console.error('[audit] Gagal menulis jejak audit:', err.message);
    return false;
  }
}

/**
 * Catat perubahan dengan membandingkan nilai sebelum & sesudah.
 * Hanya field yang benar-benar berubah yang disimpan, supaya log tetap ringkas.
 */
async function recordChange({
  userId = null,
  action,
  entity,
  entityId,
  before = null,
  after = null,
  fields = null,
  ip = null,
}) {
  const keys = fields || Object.keys({ ...(before || {}), ...(after || {}) });
  const changes = {};

  for (const key of keys) {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    if (String(from ?? '') === String(to ?? '')) continue;
    changes[key] = { from: from ?? null, to: to ?? null };
  }

  if (Object.keys(changes).length === 0) return false;

  return record({ userId, action, entity, entityId, detail: { changes }, ip });
}

/** Ambil IP klien dari request (sudah Trust Proxy diaktifkan di app.js). */
function ipOf(req) {
  if (!req) return null;
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * Daftar jejak audit terbaru dengan filter.
 *
 * @param {object} query { user_id, action, entity, entity_id, from, to, limit, offset }
 */
async function list(query = {}) {
  const where = [];
  const params = [];

  if (query.user_id) {
    where.push('a.user_id = ?');
    params.push(Number(query.user_id));
  }
  if (query.action) {
    where.push('a.action = ?');
    params.push(String(query.action).slice(0, 60));
  }
  if (query.entity) {
    where.push('a.entity = ?');
    params.push(String(query.entity).slice(0, 60));
  }
  if (query.entity_id) {
    where.push('a.entity_id = ?');
    params.push(String(query.entity_id));
  }
  if (query.from) {
    where.push('a.created_at >= ?');
    params.push(String(query.from));
  }
  if (query.to) {
    where.push('a.created_at <= ?');
    params.push(String(query.to));
  }
  if (query.search) {
    const like = `%${String(query.search).slice(0, 100)}%`;
    where.push('(a.action LIKE ? OR a.entity LIKE ? OR a.entity_id LIKE ? OR a.detail LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const perPage = Math.min(500, Math.max(1, Number(query.per_page ?? query.limit) || 100));
  const page = Math.max(1, Number(query.page) || 1);
  const offset = query.offset !== undefined
    ? Math.max(0, Number(query.offset) || 0)
    : (page - 1) * perPage;

  const total = await db.queryScalar(`SELECT COUNT(*) FROM audit_logs a ${whereSql}`, params);

  const rows = await db.queryAll(
    `SELECT a.*, u.username, u.full_name
       FROM audit_logs a
       LEFT JOIN app_users u ON u.id = a.user_id
       ${whereSql}
      ORDER BY a.id DESC
      LIMIT ${perPage} OFFSET ${offset}`,
    params
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      actor: row.full_name || row.username || null,
    })),
    meta: {
      total: Number(total || 0),
      page,
      per_page: perPage,
      total_pages: Math.max(1, Math.ceil(Number(total || 0) / perPage)),
    },
  };
}

/**
 * Ringkasan aktivitas: jumlah per jenis aksi dan per aktor.
 *
 * `days` sudah dibatasi 1..90 dan berupa angka, jadi boleh disisipkan langsung
 * ke klausa INTERVAL. MySQL tidak menerima placeholder (`INTERVAL ? DAY`),
 * sedangkan angka yang sudah divalidasi aman disisipkan apa adanya.
 */
async function summary(days = 7) {
  const span = Math.min(90, Math.max(1, Math.trunc(Number(days) || 7)));

  const byAction = await db.queryAll(
    `SELECT action, COUNT(*) AS total
       FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL ${span} DAY
      GROUP BY action
      ORDER BY total DESC
      LIMIT 20`
  );

  const byActor = await db.queryAll(
    `SELECT u.username, u.full_name, COUNT(*) AS total
       FROM audit_logs a
       LEFT JOIN app_users u ON u.id = a.user_id
      WHERE a.created_at >= NOW() - INTERVAL ${span} DAY
      GROUP BY a.user_id
      ORDER BY total DESC
      LIMIT 10`
  );

  return {
    days: span,
    by_action: byAction.map((r) => ({ action: r.action, total: Number(r.total) })),
    by_actor: byActor.map((r) => ({
      username: r.username,
      full_name: r.full_name,
      total: Number(r.total),
    })),
  };
}

module.exports = {
  record,
  recordChange,
  list,
  summary,
  ipOf,
  sanitize,
};
