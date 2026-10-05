'use strict';

const db = require('../db/pool');
const { badRequest, notFound, conflict, str, boolParam } = require('../utils/errors');
const {
  timeToMinutes,
  minutesToTime,
  parseWorkDays,
  parseWorkDaysStrict,
  isWorkDay,
} = require('../utils/date');
const config = require('../config');

/**
 * Shift = aturan jam kerja untuk kelompok karyawan.
 *disimpan sebagai kolom TIME, lalu dipakai service attendance untuk
 * menghitung keterlambatan, durasi kerja, dan lembur.
 */

const SELECT = `
  id, code, name, start_time, end_time, break_start, break_end,
  late_tolerance_min, max_work_minutes, work_days, half_day, is_active,
  created_at, updated_at
`;

async function list({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = await db.queryAll(`SELECT ${SELECT} FROM shifts ${where} ORDER BY is_active DESC, start_time ASC, name ASC`);
  return rows.map(withDuration);
}

async function getById(id) {
  const row = await db.queryOne(`SELECT ${SELECT} FROM shifts WHERE id = ?`, [id]);
  return row ? withDuration(row) : null;
}

async function getOrFail(id) {
  const row = await getById(id);
  if (!row) throw notFound(`Shift dengan id ${id} tidak ditemukan.`);
  return row;
}

async function getByCode(code) {
  const row = await db.queryOne(`SELECT ${SELECT} FROM shifts WHERE code = ?`, [String(code).trim()]);
  return row ? withDuration(row) : null;
}

/** Tambahkan durasi kerja efektif (menit) hasil perhitungan, bukan kolom DB. */
function withDuration(row) {
  return { ...row, duration_minutes: shiftDurationMinutes(row) };
}

/** Validasi & normalisasi payload shift. */
function normalize(payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.code !== undefined) {
    const code = str(payload.code, { maxLength: 20 });
    if (!code) throw badRequest('code (kode shift) wajib diisi.');
    data.code = code.toUpperCase();
  }

  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 100 });
    if (!name) throw badRequest('name (nama shift) wajib diisi.');
    data.name = name;
  }

  if (payload.start_time !== undefined) {
    const minutes = timeToMinutes(payload.start_time);
    if (minutes === null) throw badRequest('start_time tidak valid. Format: HH:MM.');
    data.start_time = minutesToTime(minutes);
  }

  if (payload.end_time !== undefined) {
    const minutes = timeToMinutes(payload.end_time);
    if (minutes === null) throw badRequest('end_time tidak valid. Format: HH:MM.');
    data.end_time = minutesToTime(minutes);
  }

  if (!partial && data.start_time !== undefined && data.end_time !== undefined) {
    const start = timeToMinutes(data.start_time);
    const end = timeToMinutes(data.end_time);
    if (start === end) throw badRequest('Jam mulai dan jam selesai tidak boleh sama.');
  }

  if (payload.break_start !== undefined) {
    data.break_start = payload.break_start ? minutesToTime(timeToMinutes(payload.break_start, 0)) : null;
  }
  if (payload.break_end !== undefined) {
    data.break_end = payload.break_end ? minutesToTime(timeToMinutes(payload.break_end, 0)) : null;
  }

  if (payload.late_tolerance_min !== undefined) {
    const value = Number(payload.late_tolerance_min);
    if (!Number.isInteger(value) || value < 0 || value > 240) {
      throw badRequest('late_tolerance_min harus angka bulat 0-240.');
    }
    data.late_tolerance_min = value;
  }

  if (payload.max_work_minutes !== undefined) {
    if (payload.max_work_minutes === '' || payload.max_work_minutes === null) {
      data.max_work_minutes = null;
    } else {
      const value = Number(payload.max_work_minutes);
      if (!Number.isInteger(value) || value < 0 || value > 1440) {
        throw badRequest('max_work_minutes harus angka bulat 0-1440 atau kosong.');
      }
      data.max_work_minutes = value;
    }
  }

  if (payload.work_days !== undefined) {
    // Validasi ketat: nilai di luar 1-7 (mis. "0" dari UI versi lama) harus
    // ditolak, bukan dibuang diam-diam supaya hari Minggu tidak hilang.
    data.work_days = parseWorkDaysStrict(payload.work_days, { label: 'work_days' }).join(',');
  }

  if (payload.half_day !== undefined) {
    const value = boolParam(payload.half_day);
    if (value === null) throw badRequest('half_day harus boolean.');
    data.half_day = value ? 1 : 0;
  }

  if (payload.is_active !== undefined) {
    const value = boolParam(payload.is_active);
    if (value === null) throw badRequest('is_active harus boolean.');
    data.is_active = value ? 1 : 0;
  }

  return data;
}

async function create(payload) {
  const data = normalize(payload);
  data.late_tolerance_min = data.late_tolerance_min ?? config.attendance.defaultLateTolerance;
  data.work_days = data.work_days ?? '1,2,3,4,5';
  data.is_active = data.is_active ?? 1;

  const existing = await getByCode(data.code);
  if (existing) throw conflict(`Kode shift "${data.code}" sudah dipakai.`);

  const columns = Object.keys(data);
  const result = await db.execute(
    `INSERT INTO shifts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => data[c])
  );

  return getById(result.insertId);
}

async function update(id, payload) {
  await getOrFail(id);
  const data = normalize(payload, { partial: true });

  if (Object.keys(data).length === 0) throw badRequest('Tidak ada field yang diubah.');

  if (data.code) {
    const existing = await getByCode(data.code);
    if (existing && existing.id !== Number(id)) throw conflict(`Kode shift "${data.code}" sudah dipakai.`);
  }

  const columns = Object.keys(data);
  await db.execute(
    `UPDATE shifts SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => data[c]), id]
  );

  return getById(id);
}

async function remove(id) {
  const shift = await getOrFail(id);

  const inUse = await db.queryScalar(
    `SELECT
       (SELECT COUNT(*) FROM employees WHERE shift_id = ?) +
       (SELECT COUNT(*) FROM schedules WHERE shift_id = ?) AS total`,
    [id, id]
  );

  if (Number(inUse) > 0) {
    throw conflict(
      `Shift masih dipakai oleh ${inUse} karyawan/jadwal sehingga tidak bisa dihapus. ` +
        'Nonaktifkan shift (is_active = 0) bila tidak dipakai lagi.'
    );
  }

  await db.execute('DELETE FROM shifts WHERE id = ?', [id]);
  return { deleted: true, shift };
}

/** Apakah shift ini merupakan hari kerja untuk tanggal tertentu? */
function isWorkingDay(shift, date) {
  if (!shift) return true;
  return isWorkDay(shift.work_days, date);
}

/** Durasi kerja efektif shift dalam menit, dikurangi waktu istirahat. */
function shiftDurationMinutes(shift) {
  if (!shift) return 0;
  const start = timeToMinutes(shift.start_time, 0);
  const end = timeToMinutes(shift.end_time, 0);

  // Shift lintas tengah malam (mis. 22:00-06:00) dihitung 24 jam penuh.
  let total = end - start;
  if (total <= 0) total += 1440;

  const breakStart = timeToMinutes(shift.break_start, null);
  const breakEnd = timeToMinutes(shift.break_end, null);
  if (breakStart !== null && breakEnd !== null) {
    let brk = breakEnd - breakStart;
    if (brk < 0) brk += 1440;
    total -= brk;
  }

  return Math.max(0, total);
}

/** Toleransi keterlambatan shift, fallback ke default global. */
function toleranceOf(shift) {
  if (shift && shift.late_tolerance_min !== null && shift.late_tolerance_min !== undefined) {
    return Number(shift.late_tolerance_min);
  }
  return config.attendance.defaultLateTolerance;
}

/** Batas jam kerja sebelum dihitung lembur, fallback ke default global. */
function maxWorkMinutesOf(shift) {
  if (shift && shift.max_work_minutes !== null && shift.max_work_minutes !== undefined) {
    return Number(shift.max_work_minutes);
  }
  return config.attendance.maxDailyWorkMinutes;
}

/** Daftar shift ringan untuk form (id, code, name, jam). */
async function options() {
  const rows = await db.queryAll(
    `SELECT id, code, name, start_time, end_time, break_start, break_end,
            work_days, late_tolerance_min
       FROM shifts
      WHERE is_active = 1
      ORDER BY start_time ASC, name ASC`
  );
  return rows.map(withDuration);
}

module.exports = {
  list,
  options,
  getById,
  getOrFail,
  getByCode,
  create,
  update,
  remove,
  normalize,
  isWorkingDay,
  shiftDurationMinutes,
  toleranceOf,
  maxWorkMinutesOf,
};
