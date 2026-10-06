'use strict';

const db = require('../db/pool');

/**
 * Notifikasi realtime via SSE native (tanpa socket.io).
 *
 * Alur: kejadian dinas/reimburse -> notifyUsers() simpan inbox +
 * dorong ke koneksi SSE yang sedang terbuka per user_id.
 * Frontend: EventSource ke /api/notifications/stream (token via query).
 */

const clients = new Map();

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function addClient(userId, res) {
  const id = Number(userId);
  if (!clients.has(id)) clients.set(id, new Set());
  const set = clients.get(id);
  for (const old of set) {
    if (old !== res) {
      try {
        old.end();
      } catch {
        // abaikan
      }
      set.delete(old);
    }
  }
  set.add(res);
}

function removeClient(userId, res) {
  const set = clients.get(Number(userId));
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(Number(userId));
}

function clientCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

/** Tutup semua koneksi SSE (dipakai saat shutdown supaya server bisa mati). */
function closeAll() {
  for (const set of clients.values()) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        // abaikan
      }
    }
  }
  clients.clear();
}

function pushToUser(userId, payload) {
  const set = clients.get(Number(userId));
  if (!set) return 0;
  let sent = 0;
  for (const res of set) {
    try {
      sseSend(res, 'notify', payload);
      sent += 1;
    } catch {
      // koneksi mati: dibersihkan saat close
    }
  }
  return sent;
}

/** Karyawan yang tertaut ke user_id tertentu. */
async function employeeIdOfUser(userId) {
  return db.queryScalar('SELECT employee_id FROM app_users WHERE id = ?', [userId]);
}

/** Semua user aktif role admin/hr (penerima pengajuan baru). */
async function reviewerUserIds() {
  const rows = await db.queryAll(
    "SELECT id FROM app_users WHERE role IN ('admin','hr') AND is_active = 1"
  );
  return rows.map((r) => r.id);
}

/** User milik seorang karyawan (portal mandiri). */
async function userIdsOfEmployee(employeeId) {
  const rows = await db.queryAll(
    'SELECT id FROM app_users WHERE employee_id = ? AND is_active = 1',
    [employeeId]
  );
  return rows.map((r) => r.id);
}

/**
 * Simpan inbox + dorong SSE ke daftar user.
 * kind: leave.submitted | leave.reviewed | reimburse.submitted | reimburse.reviewed
 */
async function notifyUsers(userIds, { kind, title, body = null, entity = null, entityId = null }) {
  const uniq = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (uniq.length === 0) return { saved: 0, pushed: 0 };

  let saved = 0;
  let pushed = 0;
  for (const userId of uniq) {
    const result = await db.execute(
      `INSERT INTO notifications (user_id, kind, title, body, entity, entity_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, kind, title, body, entity, entityId]
    );
    if (result.affectedRows > 0) saved += 1;
    pushed += pushToUser(userId, {
      id: Number(result.insertId),
      kind,
      title,
      body,
      entity,
      entity_id: entityId,
      is_read: 0,
    });
  }
  return { saved, pushed };
}

function leaveTitle(row, verb) {
  const jenis = row.subtype || row.leave_type || 'pengajuan';
  return `Dinas ${verb}: ${jenis} (${row.start_date} s/d ${row.end_date})`;
}

function isDinas(row) {
  return row && (row.leave_type === 'dinas_luar' || row.leave_type === 'dinas_dalam');
}

/** Pengajuan dinas baru -> admin/HR. Non-dinas diabaikan (bukan scope fitur ini). */
async function onLeaveSubmitted(row, employeeName) {
  if (!isDinas(row)) return null;
  const reviewers = await reviewerUserIds();
  return notifyUsers(reviewers, {
    kind: 'leave.submitted',
    title: `Pengajuan dinas baru dari ${employeeName}`,
    body: leaveTitle(row, 'menunggu persetujuan'),
    entity: 'leave_requests',
    entityId: row.id,
  });
}

/** Hasil review dinas -> karyawan pengaju. */
async function onLeaveReviewed(row, employeeName, decision) {
  if (!isDinas(row)) return null;
  const users = await userIdsOfEmployee(row.employee_id);
  const verb = decision === 'approved' ? 'disetujui' : decision === 'rejected' ? 'ditolak' : decision;
  return notifyUsers(users, {
    kind: 'leave.reviewed',
    title: `Pengajuan dinas ${verb}`,
    body: `${leaveTitle(row, verb)} oleh ${employeeName || 'admin/HR'}`,
    entity: 'leave_requests',
    entityId: row.id,
  });
}

/** Reimburse perjalanan baru -> admin/HR. */
async function onReimburseSubmitted(row, employeeName) {
  const reviewers = await reviewerUserIds();
  return notifyUsers(reviewers, {
    kind: 'reimburse.submitted',
    title: `Reimburse baru dari ${employeeName}`,
    body: `Rp ${Number(row.amount || 0).toLocaleString('id-ID')} - ${row.description || '-'}`,
    entity: 'reimburses',
    entityId: row.id,
  });
}

/** Hasil review reimburse -> karyawan pengaju. */
async function onReimburseReviewed(row, reviewerName, decision) {
  const users = await userIdsOfEmployee(row.employee_id);
  const verb = decision === 'approved' ? 'disetujui' : 'ditolak';
  return notifyUsers(users, {
    kind: 'reimburse.reviewed',
    title: `Reimburse ${verb}: Rp ${Number(row.amount || 0).toLocaleString('id-ID')}`,
    body: `${row.description || '-'} oleh ${reviewerName || 'admin/HR'}`,
    entity: 'reimburses',
    entityId: row.id,
  });
}

async function listForUser(userId, { limit = 30, unreadOnly = false } = {}) {
  const max = Math.min(100, Math.max(1, Number(limit) || 30));
  const where = unreadOnly ? 'user_id = ? AND is_read = 0' : 'user_id = ?';
  return db.queryAll(
    `SELECT id, kind, title, body, entity, entity_id, is_read, created_at
       FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ${max}`,
    [userId]
  );
}

async function unreadCount(userId) {
  return Number(await db.queryScalar(
    'SELECT COUNT(*) FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId]
  ) || 0);
}

async function markRead(userId, id) {
  if (id === 'all') {
    const result = await db.execute(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    return { updated: result.affectedRows };
  }
  const result = await db.execute(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
    [Number(id), userId]
  );
  return { updated: result.affectedRows };
}

module.exports = {
  addClient,
  removeClient,
  closeAll,
  clientCount,
  pushToUser,
  sseSend,
  notifyUsers,
  onLeaveSubmitted,
  onLeaveReviewed,
  onReimburseSubmitted,
  onReimburseReviewed,
  listForUser,
  unreadCount,
  markRead,
  employeeIdOfUser,
  reviewerUserIds,
  userIdsOfEmployee,
};
