'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const db = require('../db/pool');
const config = require('../config');
const attendanceService = require('./attendance');
const employeesService = require('./employees');
const leaveCatalog = require('./leaveCatalog');
const leaveQuota = require('./leaveQuota');
const { badRequest, notFound, forbidden } = require('../utils/errors');
const { today, toDate, startOfMonth } = require('../utils/date');

const LEAVE_TYPES = leaveCatalog.LEAVE_TYPES;
const MAX_SELFIE_BYTES = 5 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_RECEIPT_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/** Folder privat hasil selfie; TIDAK berada di dalam public/. */
const storageDir = path.join(config.root, 'storage', 'duty-checkins');
const receiptDir = path.join(config.root, 'storage', 'reimburses');

fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(receiptDir, { recursive: true });

/** Validasi + simpan satu file selfie, kembalikan nama file. */
function assertSelfieFile(file) {
  if (!file) throw badRequest('Selfie wajib diunggah.');
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    throw badRequest('Format selfie harus JPG, PNG, atau WEBP.');
  }
  if (file.size > MAX_SELFIE_BYTES) {
    throw badRequest('Ukuran selfie maksimal 5 MB.');
  }
  return true;
}

async function saveSelfieFile(employeeId, workDate, file, tag) {
  assertSelfieFile(file);
  const fileName = `${employeeId}-${workDate}-${tag}-${crypto.randomBytes(8).toString('hex')}${EXT_BY_MIME[file.mimetype]}`;
  await fsp.writeFile(path.join(storageDir, fileName), file.buffer);
  return fileName;
}

function todayStr() {
  return today();
}

/**
 * Pastikan karyawan masih aktif/non-resign sebelum membuka data portalnya.
 */
async function getSelfEmployee(employeeId) {
  const employee = await employeesService.getOrFail(employeeId);
  if (employee.status === 'resign') {
    throw forbidden('Akun ini sudah resign sehingga portal karyawan dinonaktifkan.');
  }
  return employee;
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

async function getProfile(user, employeeId) {
  const employee = await getSelfEmployee(employeeId);

  const shift = employee.shift_id
    ? await db.queryOne(
        `SELECT id, code, name, start_time, end_time, break_start, break_end,
                late_tolerance_min, work_days
           FROM shifts WHERE id = ?`,
        [employee.shift_id]
      )
    : null;

  return {
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
    },
    employee: {
      id: employee.id,
      employee_code: employee.employee_code,
      name: employee.name,
      gender: employee.gender,
      position_name: employee.position_name,
      department_name: employee.department_name,
      phone: employee.phone,
      email: employee.email,
      address: employee.address,
      status: employee.status,
    },
    shift,
    // Jadwal per tanggal (jadwal > shift default): 7 hari ke depan + 7 hari lalu.
    schedule: await getMySchedule(employeeId, {}),
    // Sisa jatah cuti tahunan, supaya karyawan bisa melihat sendiri di portal.
    leave_quota: await leaveQuota.getSummary(employee.id),
  };
}

/**
 * Jadwal kerja milik sendiri: gabungan jadwal per tanggal + shift default.
 * Tanpa jadwal = ikut shift default; tanpa shift = ikut jam global.
 */
async function getMySchedule(employeeId, query = {}) {
  await getSelfEmployee(employeeId);
  const { toDate, dateRange, addDays } = require('../utils/date');
  const from = toDate(query.from) || addDays(todayStr(), -7);
  const to = toDate(query.to) || addDays(todayStr(), 14);
  const dates = dateRange(from, to).slice(0, 60);

  const rows = await db.queryAll(
    `SELECT sc.work_date, sc.day_type, sc.note, sc.shift_id,
            s.code AS shift_code, s.name AS shift_name, s.start_time, s.end_time,
            s.late_tolerance_min
       FROM schedules sc
       LEFT JOIN shifts s ON s.id = sc.shift_id
      WHERE sc.employee_id = ? AND sc.work_date BETWEEN ? AND ?
      ORDER BY sc.work_date ASC`,
    [employeeId, from, to]
  );
  const byDate = new Map(rows.map((r) => [r.work_date, r]));

  const out = [];
  for (const date of dates) {
    const explicit = byDate.get(date) || null;
    let shift = null;
    let source = 'none';
    let dayType = explicit ? explicit.day_type : null;
    if (explicit && explicit.shift_id) {
      shift = {
        id: explicit.shift_id,
        code: explicit.shift_code,
        name: explicit.shift_name,
        start_time: explicit.start_time,
        end_time: explicit.end_time,
        late_tolerance_min: explicit.late_tolerance_min,
      };
      source = 'schedule';
    } else if (!explicit) {
      const resolved = await attendanceService.resolveShift(employeeId, date);
      shift = resolved.shift
        ? {
          id: resolved.shift.id,
          code: resolved.shift.code,
          name: resolved.shift.name,
          start_time: resolved.shift.start_time,
          end_time: resolved.shift.end_time,
          late_tolerance_min: resolved.shift.late_tolerance_min,
          is_global: resolved.shift.is_global || 0,
        }
        : null;
      source = resolved.source;
      dayType = resolved.dayType;
    }
    out.push({
      work_date: date,
      day_type: dayType || (shift ? 'kerja' : 'libur'),
      shift,
      source,
      note: explicit ? explicit.note : null,
    });
  }
  return { from, to, rows: out };
}

// ---------------------------------------------------------------------------
// Rekap kehadiran milik sendiri
// ---------------------------------------------------------------------------

async function getMyAttendance(employeeId, query = {}) {
  await getSelfEmployee(employeeId);

  const from = toDate(query.from) || startOfMonth(todayStr());
  const to = toDate(query.to) || todayStr();
  if (from > to) throw badRequest('from tidak boleh melewati to.');

  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(query.per_page) || 31));
  const offset = (page - 1) * perPage;

  const where = ['d.employee_id = ?', 'd.work_date BETWEEN ? AND ?'];
  const params = [employeeId, from, to];

  const total = await db.queryScalar(
    `SELECT COUNT(*) FROM attendance_daily d WHERE ${where.join(' AND ')}`,
    params
  );
  if (Number(total || 0) === 0) {
    // Rekap belum pernah dihitung untuk rentang ini (mis. hari ini sebelum sinkron).
    await attendanceService.generate({ from, to, employeeId, force: true });
  }

  const rows = await db.queryAll(
    `SELECT d.work_date, d.first_in, d.first_out,
            d.late_minutes, d.early_minutes, d.work_minutes, d.overtime_minutes,
            d.status, d.note
       FROM attendance_daily d
      WHERE ${where.join(' AND ')}
      ORDER BY d.work_date DESC
      LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  const summaryRows = await db.queryAll(
    `SELECT status, COUNT(*) AS total
       FROM attendance_daily
      WHERE employee_id = ? AND work_date BETWEEN ? AND ?
      GROUP BY status`,
    [employeeId, from, to]
  );

  const byStatus = {};
  for (const row of summaryRows) {
    byStatus[row.status] = Number(row.total);
    byStatus[`${row.status}_label`] = attendanceService.STATUS_LABEL[row.status] || row.status;
  }

  return {
    range: { from, to },
    rows: rows.map(decorateAttendanceRow),
    by_status: byStatus,
    totals: {
      hadir: attendanceService.ATTENDED_STATUSES.reduce(
        (sum, key) => sum + (byStatus[key] || 0),
        0
      ),
      dinas_luar: byStatus.dinas_luar || 0,
      dinas_dalam: byStatus.dinas_dalam || 0,
    },
    meta: {
      total: Number(total || 0),
      page,
      per_page: perPage,
      total_pages: perPage > 0 ? Math.ceil(Number(total || 0) / perPage) : 0,
    },
  };
}

function decorateAttendanceRow(row) {
  return {
    ...row,
    tanggal: row.work_date,
    jam_masuk: formatClock(row.first_in),
    jam_keluar: formatClock(row.first_out),
    status_label: attendanceService.STATUS_LABEL[row.status] || row.status,
  };
}

function formatClock(value) {
  if (!value) return null;
  const s = String(value);
  return s.length >= 16 ? s.slice(11, 16) : s;
}

// ---------------------------------------------------------------------------
// Pengajuan izin / sakit / cuti / dinas luar
// ---------------------------------------------------------------------------

async function listLeaves(employeeId, query = {}) {
  await getSelfEmployee(employeeId);

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const rows = await db.queryAll(
    `SELECT id, leave_type, subtype, place, start_date, end_date, reason, status,
            review_note, reviewed_at, created_at
       FROM leave_requests
      WHERE employee_id = ?
      ORDER BY start_date DESC, id DESC
      LIMIT ?`,
    [employeeId, limit]
  );

  return rows.map((row) => ({
    ...row,
    category: leaveCatalog.categoryForLeave(row.leave_type, row.subtype),
    subtype_label: row.subtype
      ? leaveCatalog.labelForLeave(row.leave_type, row.subtype)
      : attendanceService.STATUS_LABEL[row.leave_type] || row.leave_type,
  }));
}

/**
 * Karyawan membuat pengajuan untuk dirinya sendiri. Status awal selalu pending
 * sehingga wajib melalui persetujuan admin/HR seperti pengajuan manual.
 *
 * Payload mengikuti form bertingkat: kategori (cuti/izin/dinas) + sub_jenis.
 * Bila sub_jenis tidak dikirim, sub_jenis pertama pada kategori yang cocok
 * dipakai agar data lama tetap bisa dikirim ulang.
 */
async function createLeave(employeeId, payload = {}) {
  await getSelfEmployee(employeeId);

  const categoryKey = payload.category ? String(payload.category) : '';
  const subtypeKey = payload.subtype ? String(payload.subtype) : '';
  const subtype = resolveSubtype(categoryKey, subtypeKey);

  const startDate = toDate(payload.start_date);
  if (!startDate) throw badRequest('Tanggal mulai wajib diisi.');

  // Dinas dalam kota hanya berlaku 1 hari, jadi tanggal selesai dipaksa sama.
  const endDate = subtype.single_day ? startDate : toDate(payload.end_date || startDate);
  if (!endDate) throw badRequest('Tanggal selesai tidak valid.');
  if (endDate < startDate) throw badRequest('Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');

  if (!subtype.needs_place && payload.place) {
    throw badRequest('Lokasi hanya diisi untuk pengajuan dinas.');
  }

  const place = subtype.needs_place
    ? String(payload.place || '').trim().slice(0, 150) || null
    : null;
  if (subtype.needs_place && !place) {
    throw badRequest(`Lokasi/tujuan wajib diisi untuk ${subtype.label}.`);
  }

  const reason = payload.reason ? String(payload.reason).trim().slice(0, 500) : null;

  const result = await db.execute(
    `INSERT INTO leave_requests
       (employee_id, leave_type, subtype, place, start_date, end_date, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, subtype.leave_type, subtype.key, place, startDate, endDate, reason]
  );

  const row = await db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [result.insertId]);

  // Simpan jumlah hari kerja yang akan dipotong dari jatah cuti tahunan.
  await leaveQuota.prepareLeave(row);

  return decorateLeave(row);
}

/** Pilotkan sub_jenis terhadap kategori; error dilempar sebagai badRequest. */
function resolveSubtype(categoryKey, subtypeKey) {
  const category = categoryKey
    ? leaveCatalog.findCategory(categoryKey)
    : null;

  if (categoryKey && !category) {
    throw badRequest(
      `Kategori pengajuan tidak valid. Pilihan: ${leaveCatalog.CATEGORIES.map((c) => c.key).join(', ')}.`
    );
  }

  const subtype = leaveCatalog.findSubtype(subtypeKey);
  if (subtypeKey && !subtype) {
    throw badRequest('Jenis pengajuan tidak valid untuk kategori yang dipilih.');
  }

  if (subtype) {
    // Kategori wajib cocok supaya tidak bisa mengirim izin di kolom dinas.
    if (category && subtype.category !== category.key) {
      throw badRequest(
        `Jenis "${subtype.label}" tidak termasuk kategori ${category.label}.`
      );
    }
    return subtype;
  }

  // Tanpa kategori maupun sub_jenis: pakai allowlist leave_type lama.
  const legacyType = String(categoryKey);
  if (leaveCatalog.LEAVE_TYPES.includes(legacyType)) {
    const match = leaveCatalog.CATEGORIES
      .flatMap((c) => c.subtypes)
      .find((s) => s.leave_type === legacyType);
    if (match) return match;
  }

  throw badRequest(
    `Jenis pengajuan wajib dipilih. Pilihan kategori: ${leaveCatalog.CATEGORIES.map((c) => c.label).join(', ')}.`
  );
}

/** Tambahkan label yang siap dipakai UI. */
function decorateLeave(row) {
  if (!row) return row;

  const days = Number(row.quota_days || 0);
  const usesQuota = leaveQuota.usesQuota(row);

  return {
    ...row,
    category: leaveCatalog.categoryForLeave(row.leave_type, row.subtype),
    subtype_label: row.subtype
      ? leaveCatalog.labelForLeave(row.leave_type, row.subtype)
      : attendanceService.STATUS_LABEL[row.leave_type] || row.leave_type,
    uses_quota: usesQuota,
    quota_days: usesQuota ? days : 0,
  };
}

// ---------------------------------------------------------------------------
// Reimburse biaya perjalanan dinas (portal mandiri)
// ---------------------------------------------------------------------------

async function listReimburses(employeeId, query = {}) {
  await getSelfEmployee(employeeId);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const rows = await db.queryAll(
    `SELECT id, employee_id, description, amount, attachment, status,
            reviewed_by, reviewed_at, created_at
       FROM reimburses WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [employeeId, limit]
  );
  return rows.map((row) => ({
    ...row,
    receipt_url: row.attachment ? `/api/me/reimburses/${row.id}/receipt` : null,
  }));
}

/**
 * Bukti struk/nota reimburse: JPG/PNG/WEBP/PDF maks 10 MB.
 * Opsional — null bila karyawan tidak melampirkan.
 */
function assertReceiptFile(file) {
  if (!file) return null;
  if (!ALLOWED_RECEIPT_MIME.includes(file.mimetype)) {
    throw badRequest('Bukti harus JPG, PNG, WEBP, atau PDF.');
  }
  if (file.size > MAX_RECEIPT_BYTES) {
    throw badRequest('Ukuran bukti maksimal 10 MB.');
  }
  return true;
}

async function saveReceiptFile(employeeId, file) {
  assertReceiptFile(file);
  if (!file) return null;
  const fileName = `${employeeId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${EXT_BY_MIME[file.mimetype]}`;
  await fsp.writeFile(path.join(receiptDir, fileName), file.buffer);
  return fileName;
}

function receiptMimeOf(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** Ambil file bukti reimburse milik sendiri (path dari DB, bukan dari user). */
async function getReceiptFile(employeeId, reimburseId) {
  const row = await db.queryOne(
    'SELECT id, attachment FROM reimburses WHERE id = ? AND employee_id = ?',
    [Number(reimburseId), employeeId]
  );
  if (!row || !row.attachment) throw notFound('Bukti tidak ditemukan.');
  const name = path.basename(String(row.attachment));
  const absolute = path.join(receiptDir, name);
  if (!absolute.startsWith(receiptDir + path.sep)) throw notFound('Bukti tidak ditemukan.');
  if (!fs.existsSync(absolute)) throw notFound('Bukti tidak ditemukan.');
  return { absolute, mime: receiptMimeOf(name), name };
}

async function createReimburse(employeeId, payload = {}, file = null) {
  await getSelfEmployee(employeeId);
  const description = String(payload.description || '').trim().slice(0, 500);
  if (!description) throw badRequest('description wajib diisi.');
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amount harus angka > 0.');
  const attachment = await saveReceiptFile(employeeId, file);
  try {
    const result = await db.execute(
      `INSERT INTO reimburses (employee_id, description, amount, attachment, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [employeeId, description, amount, attachment]
    );
    return db.queryOne('SELECT * FROM reimburses WHERE id = ?', [result.insertId]);
  } catch (err) {
    if (attachment) await fsp.unlink(path.join(receiptDir, attachment)).catch(() => {});
    throw err;
  }
}

/**
 * Simpan banyak item reimburse sekaligus (satu pengiriman multi-form).
 * items: [{ description, amount }], files: sejajar index (boleh kosong).
 * Validasi semua dulu, lalu insert satu per satu. Maks 20 baris.
 */
async function createReimburseBatch(employeeId, items = [], files = []) {
  await getSelfEmployee(employeeId);
  if (!Array.isArray(items) || items.length === 0) throw badRequest('Minimal satu item reimburse.');
  if (items.length > 20) throw badRequest('Maksimal 20 item per pengiriman.');

  const clean = items.map((it, i) => {
    const description = String(it.description || '').trim().slice(0, 500);
    const amount = Number(it.amount);
    if (!description) throw badRequest(`Item ${i + 1}: description wajib diisi.`);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest(`Item ${i + 1}: amount harus > 0.`);
    const file = files[i] || null;
    assertReceiptFile(file);
    return { description, amount, file };
  });

  const savedFiles = [];
  const rows = [];
  try {
    for (const it of clean) {
      const attachment = await saveReceiptFile(employeeId, it.file);
      if (attachment) savedFiles.push(attachment);
      const result = await db.execute(
        `INSERT INTO reimburses (employee_id, description, amount, attachment, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [employeeId, it.description, it.amount, attachment]
      );
      rows.push(await db.queryOne('SELECT * FROM reimburses WHERE id = ?', [result.insertId]));
    }
    return rows;
  } catch (err) {
    for (const name of savedFiles) {
      await fsp.unlink(path.join(receiptDir, name)).catch(() => {});
    }
    throw err;
  }
}

/** Batalkan pengajuan sendiri selama masih pending. */
async function cancelLeave(employeeId, leaveId) {
  const row = await db.queryOne(
    'SELECT * FROM leave_requests WHERE id = ? AND employee_id = ?',
    [Number(leaveId), employeeId]
  );
  if (!row) throw notFound('Pengajuan tidak ditemukan.');
  if (row.status !== 'pending') {
    throw badRequest('Hanya pengajuan berstatus pending yang bisa dibatalkan.');
  }

  await db.execute(
    "UPDATE leave_requests SET status = 'rejected', review_note = 'Dibatalkan oleh pengaju' WHERE id = ?",
    [row.id]
  );

  return db.queryOne('SELECT * FROM leave_requests WHERE id = ?', [row.id]);
}

// ---------------------------------------------------------------------------
// Dinas luar kota: GPS + jam + selfie
// ---------------------------------------------------------------------------

/** Pengajuan dinas (dalam/luar kota) yang sudah disetujui dan mencakup hari ini. */
async function getApprovedDutyLeave(employeeId, workDate) {
  return db.queryOne(
    `SELECT id, leave_type, subtype, place, start_date, end_date, reason
       FROM leave_requests
      WHERE employee_id = ?
        AND leave_type IN ('dinas_luar', 'dinas_dalam')
        AND status = 'approved'
        AND ? BETWEEN start_date AND end_date
      ORDER BY start_date DESC
      LIMIT 1`,
    [employeeId, workDate]
  );
}

/** Persetujuan dinas terdekat yang belum kedaluwarsa (untuk pesan error). */
async function getNearestDutyLeave(employeeId, workDate) {
  return db.queryOne(
    `SELECT id, leave_type, subtype, place, start_date, end_date, reason
       FROM leave_requests
      WHERE employee_id = ?
        AND leave_type IN ('dinas_luar', 'dinas_dalam')
        AND status = 'approved'
        AND end_date >= ?
      ORDER BY start_date ASC
      LIMIT 1`,
    [employeeId, workDate]
  );
}

/** Rentang YYYY-MM-DD dari sebuah pengajuan dinas. */
function dutyRangeOf(leave) {
  if (!leave) return null;
  const start = toDate(leave.start_date) || String(leave.start_date || '').slice(0, 10) || null;
  const end = toDate(leave.end_date) || String(leave.end_date || '').slice(0, 10) || null;
  if (!start || !end) return null;
  return { start, end };
}

function rangeLabel(range) {
  return range ? `${range.start} s/d ${range.end}` : '-';
}

/**
 * Validasi murni: tanggal check-in/out harus hari ini (GPS live) dan di dalam
 * rentang persetujuan. Murni supaya mudah diuji.
 */
function assertDutyWorkDate(workDate, leave, todayDate = todayStr()) {
  if (workDate !== todayDate) {
    throw badRequest(`Check-in/check-out dinas hanya bisa untuk hari ini (${todayDate}).`);
  }
  const range = dutyRangeOf(leave);
  if (!range) {
    throw badRequest('Tidak ada persetujuan dinas untuk tanggal tersebut.');
  }
  if (workDate < range.start || workDate > range.end) {
    throw badRequest(
      `Tanggal ${workDate} di luar rentang dinas yang disetujui (${rangeLabel(range)}).`
    );
  }
  return range;
}

async function getToday(employeeId) {
  await getSelfEmployee(employeeId);

  const workDate = todayStr();
  const leave = await getApprovedDutyLeave(employeeId, workDate);
  const duty = await attendanceService.getDutyCheckin(employeeId, workDate);
  const daily = await db.queryOne(
    'SELECT work_date, first_in, first_out, late_minutes, work_minutes, overtime_minutes, status, note FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employeeId, workDate]
  );

  const range = dutyRangeOf(leave);
  if (duty) {
    duty.selfie_url = duty.selfie_path ? `/api/me/duty-checkins/${duty.id}/selfie` : null;
    duty.selfie_out_url = duty.checkout_selfie_path ? `/api/me/duty-checkins/${duty.id}/selfie-out` : null;
  }
  return {
    work_date: workDate,
    server_time: new Date().toISOString(),
    can_check_in: Boolean(leave) && !duty,
    duty_range: range,
    // Alasan check-in ditutup ditampilkan agar karyawan tidak bingung.
    check_in_blocked_reason: !leave
      ? 'Belum ada pengajuan dinas yang disetujui untuk hari ini.'
      : duty
        ? 'Anda sudah check-in dinas hari ini.'
        : null,
    approved_duty_leave: leave,
    duty,
    daily: daily ? decorateAttendanceRow(daily) : null,
  };
}

/**
 * Catat check-in dinas (dalam/luar kota).
 * Wajib punya pengajuan dinas yang sudah disetujui untuk tanggal tersebut,
 * coordinate dari GPS browser, dan selfie. Waktu diambil dari server.
 */
async function checkIn(employeeId, payload = {}, file = null) {
  await getSelfEmployee(employeeId);

  const workDate = toDate(payload.work_date) || todayStr();
  const now = todayStr();
  if (workDate !== now) {
    throw badRequest(`Check-in dinas hanya bisa untuk hari ini (${now}), bukan ${workDate}.`);
  }

  const leave = await getApprovedDutyLeave(employeeId, workDate);
  if (!leave) {
    const other = await db.queryOne(
      `SELECT start_date, end_date FROM leave_requests
        WHERE employee_id = ?
          AND leave_type IN ('dinas_luar', 'dinas_dalam')
          AND status = 'approved'
        ORDER BY end_date DESC LIMIT 1`,
      [employeeId]
    );
    const hint = other
      ? ` Persetujuan terakhir: ${rangeLabel(dutyRangeOf(other))}.`
      : '';
    throw badRequest(
      `Check-in ditolak: tidak ada persetujuan dinas untuk ${workDate}.${hint}`
    );
  }
  assertDutyWorkDate(workDate, leave, now);

  const existing = await attendanceService.getDutyCheckin(employeeId, workDate);
  if (existing) {
    throw badRequest(`Anda sudah check-in dinas pada ${workDate}.`);
  }

  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const accuracy = payload.accuracy === undefined || payload.accuracy === ''
    ? null
    : Number(payload.accuracy);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw badRequest('latitude tidak valid (harus -90 sampai 90).');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw badRequest('longitude tidak valid (harus -180 sampai 180).');
  }
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) {
    throw badRequest('accuracy tidak valid.');
  }

  const address = payload.address ? String(payload.address).trim().slice(0, 255) : null;
  const note = payload.note ? String(payload.note).trim().slice(0, 500) : null;

  const fileName = await saveSelfieFile(employeeId, workDate, file, 'in');
  const filePath = path.join(storageDir, fileName);

  try {
    const result = await db.execute(
      `INSERT INTO duty_checkins
         (employee_id, work_date, check_in_at, latitude, longitude, accuracy_m,
          address, selfie_path, note, leave_id)
       VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
      [employeeId, workDate, latitude, longitude, accuracy, address, fileName, note, leave.id]
    );

    // Rekap harian langsung dihitung ulang agar status dinas + jam portal
    // tampil tanpa perlu menunggu backfill.
    await attendanceService.generateForEmployee(employeeId, workDate);

    const row = await db.queryOne('SELECT * FROM duty_checkins WHERE id = ?', [result.insertId]);
    return row;
  } catch (err) {
    // Jangan simpan berkas yatim bila insert gagal.
    await fsp.unlink(filePath).catch(() => {});
    throw err;
  }
}

/** Check-out wajib selfie; jam dipakai untuk menghitung durasi kerja. */
async function checkOut(employeeId, payload = {}, file = null) {
  const workDate = toDate(payload.work_date) || todayStr();
  const now = todayStr();
  if (workDate !== now) {
    throw badRequest(`Check-out dinas hanya bisa untuk hari ini (${now}), bukan ${workDate}.`);
  }

  const leave = await getApprovedDutyLeave(employeeId, workDate);
  if (!leave) {
    throw badRequest(`Check-out ditolak: tidak ada persetujuan dinas untuk ${workDate}.`);
  }
  assertDutyWorkDate(workDate, leave, now);

  const duty = await attendanceService.getDutyCheckin(employeeId, workDate);
  if (!duty) throw notFound('Belum ada check-in dinas luar pada tanggal ini.');
  if (duty.check_out_at) throw badRequest('Anda sudah check-out hari ini.');

  const fileName = await saveSelfieFile(employeeId, workDate, file, 'out');
  const filePath = path.join(storageDir, fileName);
  try {
    await db.execute(
      'UPDATE duty_checkins SET check_out_at = NOW(), checkout_selfie_path = ? WHERE id = ? AND check_out_at IS NULL',
      [fileName, duty.id]
    );
  } catch (err) {
    await fsp.unlink(filePath).catch(() => {});
    throw err;
  }
  await attendanceService.generateForEmployee(employeeId, workDate);

  return db.queryOne('SELECT * FROM duty_checkins WHERE id = ?', [duty.id]);
}

async function listDuty(employeeId, query = {}) {
  await getSelfEmployee(employeeId);

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const rows = await db.queryAll(
    `SELECT d.id, d.work_date, d.check_in_at, d.check_out_at, d.latitude, d.longitude,
            d.accuracy_m, d.address, d.note, d.selfie_path, d.checkout_selfie_path
       FROM duty_checkins d
      WHERE d.employee_id = ?
      ORDER BY d.work_date DESC, d.id DESC
      LIMIT ?`,
    [employeeId, limit]
  );

  return rows.map((row) => ({
    ...row,
    jam_masuk: formatClock(row.check_in_at),
    jam_keluar: formatClock(row.check_out_at),
    // Path relatif saja; file diunduh lewat endpoint ber-token.
    selfie_url: row.selfie_path ? `/api/me/duty-checkins/${row.id}/selfie` : null,
    selfie_out_url: row.checkout_selfie_path ? `/api/me/duty-checkins/${row.id}/selfie-out` : null,
  }));
}

/**
 * Kirim berkas selfie milik sendiri. Path diambil dari DB (bukan dari user),
 * lalu divalidasi agar tidak keluar dari folder penyimpanan.
 * kind: 'in' (check-in) atau 'out' (check-out).
 */
async function getSelfieFile(employeeId, dutyId, kind = 'in') {
  const column = kind === 'out' ? 'checkout_selfie_path' : 'selfie_path';
  const row = await db.queryOne(
    `SELECT id, ${column} AS selfie_path FROM duty_checkins WHERE id = ? AND employee_id = ?`,
    [Number(dutyId), employeeId]
  );
  if (!row || !row.selfie_path) throw notFound('Foto tidak ditemukan.');

  const name = path.basename(String(row.selfie_path));
  const absolute = path.join(storageDir, name);
  // Sabuk pengaman: pastikan hasil resolve masih di dalam storageDir.
  if (!absolute.startsWith(storageDir + path.sep)) throw notFound('Foto tidak ditemukan.');
  if (!fs.existsSync(absolute)) throw notFound('Foto tidak ditemukan.');

  return { absolute, mime: mimeOf(name) };
}

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

module.exports = {
  LEAVE_TYPES,
  LEAVE_OPTIONS: leaveCatalog.toPublicOptions(),
  MAX_SELFIE_BYTES,
  ALLOWED_MIME,
  storageDir,
  getProfile,
  getMySchedule,
  getMyAttendance,
  listLeaves,
  createLeave,
  cancelLeave,
  listReimburses,
  createReimburse,
  createReimburseBatch,
  getReceiptFile,
  receiptDir,
  MAX_RECEIPT_BYTES,
  ALLOWED_RECEIPT_MIME,
  getToday,
  getApprovedDutyLeave,
  getNearestDutyLeave,
  dutyRangeOf,
  rangeLabel,
  assertDutyWorkDate,
  checkIn,
  checkOut,
  listDuty,
  getSelfieFile,
  formatClock,
};