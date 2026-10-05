'use strict';

/**
 * Jatah cuti tahunan (kuota) per karyawan.
 *
 * Berbeda dari modul lain, kuota ini disimpan sebagai penghitung (counter) pada
 * tabel `employees`, bukan dihitung ulang dari `leave_requests`. Alasannya:
 * fitur "reset cuti" harus mengembalikan jatah ke jumlah semula tanpa menghapus
 * atau mengubah riwayat pengajuan yang sudah disetujui. Setiap perubahan tetap
 * dicatat di `leave_quota_logs` sebagai jejak audit.
 *
 * Aturan:
 *   - Hanya berlaku untuk sub-jenis `cuti_tahunan`. Cuti sakit, melahirkan,
 *     cepat nikah, haji, dan sejenisnya tidak memotong jatah.
 *   - Jatah diinput manual oleh admin/HR, bukan dihitung dari masa kerja.
 *   - Pengajuan yang disetujui memotong jatah sebesar jumlah HARI KERJA dalam
 *     rentangnya, sehingga cuti Jumat-Minggu hanya memotong satu hari.
 *   - Pengajuan yang ditolak, dibatalkan, atau dikembalikan ke pending
 *     mengembalikan jatah sebesar jumlah yang sebelumnya dipotong.
 *   - Reset mengembalikan jatah terpakai ke 0; jatah pokok tidak berubah dan
 *     riwayat pengajuan tetap utuh.
 */

const db = require('../db/pool');
const leaveCatalog = require('./leaveCatalog');
const { notFound } = require('../utils/errors');
const { dateRange, isWorkDay } = require('../utils/date');

/** Sub-jenis yang memakai jatah cuti tahunan. */
const QUOTA_SUBTYPE = 'cuti_tahunan';

const MAX_QUOTA_DAYS = 365;

/**
 * Berapa hari kerja yang dipotong sebuah pengajuan.
 *
 * Mengikuti `work_days` shift karyawan sehingga akhir pekan tidak dihitung.
 * Bila hari kerja tidak diketahui, semua hari dalam rentang dihitung.
 *
 * @param {string|null} workDaysContoh String "1,2,3,4,5" atau null.
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate   YYYY-MM-DD
 * @returns {number} jumlah hari kerja, minimal 0
 */
function countQuotaDays(workDays, startDate, endDate) {
  const days = dateRange(startDate, endDate);
  if (days.length === 0) return 0;
  return days.filter((date) => isWorkDay(workDays, date)).length;
}

/**
 * Apakah pengajuan ini memakai jatah cuti tahunan?
 *
 * Pengajuan lama tanpa subtype diperlakukan sebagai cuti tahunan hanya bila
 * leave_type-nya `cuti`, supaya izin dan sakit tidak ikut memotong jatah.
 */
function usesQuota(leave) {
  if (!leave) return false;
  if (leave.subtype) return leave.subtype === QUOTA_SUBTYPE;
  return leave.leave_type === 'cuti';
}

/** Label pengajuan untuk pesan error. */
function leaveLabel(leave) {
  return leaveCatalog.labelForLeave(leave.leave_type, leave.subtype);
}

/**
 * Ringkasan jatah cuti seorang karyawan.
 * @returns {Promise<{quota:number, used:number, remaining:number, reset_at:string|null}>}
 */
async function getSummary(employeeId) {
  const row = await db.queryOne(
    'SELECT annual_leave_quota, annual_leave_used, annual_leave_reset_at FROM employees WHERE id = ?',
    [employeeId]
  );
  if (!row) throw notFound(`Karyawan dengan id ${employeeId} tidak ditemukan.`);

  return decorateSummary(row);
}

function decorateSummary(row) {
  const quota = Number(row.annual_leave_quota || 0);
  const used = Number(row.annual_leave_used || 0);
  return {
    quota,
    used,
    remaining: quota - used,
    reset_at: row.annual_leave_reset_at || null,
  };
}

/** Ringkasan untuk banyak karyawan sekaligus (dipakai list & form pengajuan). */
async function getSummaryMap(employeeIds) {
  const ids = [...new Set((employeeIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return {};

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.queryAll(
    `SELECT id, annual_leave_quota, annual_leave_used, annual_leave_reset_at
       FROM employees
      WHERE id IN (${placeholders})`,
    ids
  );

  const map = {};
  for (const row of rows) map[row.id] = decorateSummary(row);
  return map;
}

/** Tulis jejak audit perubahan jatah. */
async function logChange({
  employeeId,
  action,
  days,
  quotaBefore,
  usedBefore,
  usedAfter,
  leaveId = null,
  reason = null,
  actorId = null,
}) {
  await db.execute(
    `INSERT INTO leave_quota_logs
       (employee_id, action, days, quota_before, used_before, used_after, leave_id, reason, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, action, days, quotaBefore, usedBefore, usedAfter, leaveId, reason, actorId]
  );
}

/** Baca baris employees untuk perhitungan, termasuk work_days shift bila ada. */
async function loadEmployee(employeeId) {
  return db.queryOne(
    `SELECT e.id, e.name, e.annual_leave_quota, e.annual_leave_used, e.shift_id,
            s.work_days
       FROM employees e
       LEFT JOIN shifts s ON s.id = e.shift_id
      WHERE e.id = ?`,
    [employeeId]
  );
}

/**
 * Hitung dan simpan jumlah hari yang akan dipotong sebuah pengajuan.
 *
 * Dipanggil saat pengajuan dibuat (portal karyawan maupun dicatat admin/HR)
 * supaya jumlah hari kerja sudah final ketika pengajuan disetujui.
 *
 * Objek `leave` yang diberikan ikut diperbarui di_place agar pemanggil bisa
 * langsung memakai `quota_days` tanpa query ulang.
 *
 * @returns {Promise<number>} jumlah hari kerja
 */
async function prepareLeave(leave) {
  if (!usesQuota(leave)) return 0;

  const employee = await loadEmployee(leave.employee_id);
  if (!employee) return 0;

  const days = countQuotaDays(employee.work_days, leave.start_date, leave.end_date);
  await db.execute('UPDATE leave_requests SET quota_days = ? WHERE id = ?', [days, leave.id]);

  leave.quota_days = days;
  return days;
}

/**
 * Terapkan pengurangan atau pengembalian jatah untuk satu pengajuan.
 *
 * Aman dipanggil berulang: jumlah yang dipotong dibaca dari
 * `leave_requests.quota_days`, bukan dihitung ulang, sehingga pembalikan status
 * mengembalikan jumlah yang tepat dan tidak memotong dua kali.
 *
 * `annual_leave_used` menghitung hari yang SUDAH DIPAKAI, jadi menyetujui
 * pengajuan menaikkan angka itu dan mencabut persetujuan menurunkannya.
 *
 * @param {object} leave Baris leave_requests.
 * @param {'potong'|'kembalikan'} direction
 * @returns {Promise<{changed:boolean, days:number}>}
 */
async function applyLeaveChange(leave, direction, { actorId = null, reason = null } = {}) {
  if (!usesQuota(leave)) return { changed: false, days: 0 };

  const days = Number(leave.quota_days || 0);
  if (days <= 0) return { changed: false, days: 0 };

  const employee = await loadEmployee(leave.employee_id);
  if (!employee) return { changed: false, days: 0 };

  const quota = Number(employee.annual_leave_quota || 0);
  const usedBefore = Number(employee.annual_leave_used || 0);
  // "potong" = jatah terpakai bertambah; "kembalikan" = terpakai berkurang.
  const delta = direction === 'potong' ? days : -days;
  const usedAfter = Math.max(0, usedBefore + delta);
  const actual = usedAfter - usedBefore;
  if (actual === 0) return { changed: false, days: 0 };

  await db.execute('UPDATE employees SET annual_leave_used = ? WHERE id = ?', [usedAfter, leave.employee_id]);
  await logChange({
    employeeId: leave.employee_id,
    action: direction,
    // Bertanda sesuai perubahan angka terpakai: positif saat dipotong.
    days: actual,
    quotaBefore: quota,
    usedBefore,
    usedAfter,
    leaveId: leave.id || null,
    reason,
    actorId,
  });

  return { changed: true, days: Math.abs(actual) };
}

/**
 * Apakah pengajuan ini masih muat dalam jatah yang tersisa?
 *
 * `force: true` melewati pengecekan sehingga admin/HR tetap bisa menyetujui
 * walau jatah kurang, dan pengajuan yang sudah dilewati tetap memotong jatah.
 *
 * @returns {Promise<{ok:boolean, days:number, quota:number, used:number, remaining:number, message:string|null}>}
 */
async function checkQuota(leave, { force = false } = {}) {
  if (!usesQuota(leave)) {
    return { ok: true, days: 0, quota: 0, used: 0, remaining: 0, message: null };
  }

  // quota_days bisa 0 untuk pengajuan lama yang belum dihitung.
  let days = Number(leave.quota_days || 0);
  if (days === 0) days = await prepareLeave(leave);

  const summary = await getSummary(leave.employee_id);
  const ok = force || days <= summary.remaining;

  return {
    ok,
    days,
    quota: summary.quota,
    used: summary.used,
    remaining: summary.remaining,
    message: ok
      ? null
      : `Jatah cuti tahunan ${leaveLabel(leave)} untuk ${leave.employee_name || 'karyawan ini'} ` +
        `memakai ${days} hari kerja, sedangkan sisa jatah hanya ${summary.remaining} hari. ` +
        'Kirim force: true untuk menyetujui trotz jatah kurang.',
  };
}

/**
 * Kembalikan jatah ke jumlah semula (jatah terpakai = 0).
 *
 * Status pengajuan yang sudah disetujui tidak diubah, jadi riwayat cuti tetap
 * utuh; yang dikembalikan hanya hitungannya.
 */
async function reset(employeeId, { actorId = null, reason = null } = {}) {
  const employee = await db.queryOne(
    'SELECT annual_leave_quota, annual_leave_used FROM employees WHERE id = ?',
    [employeeId]
  );
  if (!employee) throw notFound(`Karyawan dengan id ${employeeId} tidak ditemukan.`);

  const quota = Number(employee.annual_leave_quota || 0);
  const usedBefore = Number(employee.annual_leave_used || 0);

  await db.execute(
    'UPDATE employees SET annual_leave_used = 0, annual_leave_reset_at = NOW() WHERE id = ?',
    [employeeId]
  );

  if (usedBefore > 0) {
    await logChange({
      employeeId,
      action: 'reset',
      days: usedBefore,
      quotaBefore: quota,
      usedBefore,
      usedAfter: 0,
      reason,
      actorId,
    });
  }

  return { quota, used_before: usedBefore, used: 0, remaining: quota, changed: usedBefore > 0 };
}

/**
 * Ubah jatah pokok, misalnya karena HR menaikkan jatah karyawan.
 * Sisa mengikuti jatah baru dan tidak pernah negatif.
 */
async function setQuota(employeeId, quota, { actorId = null, reason = null } = {}) {
  const employee = await db.queryOne(
    'SELECT annual_leave_quota, annual_leave_used FROM employees WHERE id = ?',
    [employeeId]
  );
  if (!employee) throw notFound(`Karyawan dengan id ${employeeId} tidak ditemukan.`);

  const quotaBefore = Number(employee.annual_leave_quota || 0);
  const usedBefore = Number(employee.annual_leave_used || 0);
  const next = Math.max(0, Math.min(MAX_QUOTA_DAYS, Math.trunc(Number(quota) || 0)));
  const usedAfter = Math.min(usedBefore, next);

  await db.execute(
    'UPDATE employees SET annual_leave_quota = ?, annual_leave_used = ? WHERE id = ?',
    [next, usedAfter, employeeId]
  );

  if (quotaBefore !== next || usedBefore !== usedAfter) {
    await logChange({
      employeeId,
      action: 'set_jatah',
      days: next - quotaBefore,
      quotaBefore,
      usedBefore,
      usedAfter,
      reason,
      actorId,
    });
  }

  return { quota: next, used: usedAfter, remaining: next - usedAfter };
}

/** Riwayat perubahan jatah seorang karyawan (terbaru lebih dulu). */
async function history(employeeId, { limit = 50 } = {}) {
  const max = Math.min(500, Math.max(1, Number(limit) || 50));
  return db.queryAll(
    `SELECT q.*, u.username AS actor_username, u.full_name AS actor_full_name,
            lr.start_date, lr.end_date
       FROM leave_quota_logs q
       LEFT JOIN app_users u ON u.id = q.actor_id
       LEFT JOIN leave_requests lr ON lr.id = q.leave_id
      WHERE q.employee_id = ?
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT ${max}`,
    [employeeId]
  );
}

module.exports = {
  QUOTA_SUBTYPE,
  MAX_QUOTA_DAYS,
  countQuotaDays,
  usesQuota,
  leaveLabel,
  getSummary,
  getSummaryMap,
  prepareLeave,
  checkQuota,
  applyLeaveChange,
  reset,
  setQuota,
  history,
};
