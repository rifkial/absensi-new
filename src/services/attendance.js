'use strict';

const db = require('../db/pool');
const config = require('../config');
const shiftsService = require('./shifts');
const settingsService = require('./settings');
const holidaysService = require('./holidays');
const leaveCatalog = require('./leaveCatalog');
const {
  today,
  toDate,
  dateRange,
  timeToMinutes,
  minutesToTime,
  isoDayOfWeek,
  addDays,
  formatDateTime,
} = require('../utils/date');

/**
 * Perhitungan rekap absensi harian.
 *
 * Prinsip:
 *  - attendance_logs = data mentah dari mesin (sumber kebenaran)
 *  - attendance_daily = hasil hitungan (cache yang bisa di-regenerate kapan saja)
 *
 * Semua perhitungan diulang dari attendance_logs setiap kali rekap dibuat, jadi
 * re-generate bersifat idempoten dan aman dijalankan berkali-kali.
 */

/** Peta nilai log_state dari mesin ke makna. */
const LOG_STATE = {
  0: 'check_in',
  1: 'check_out',
  2: 'break_out',
  3: 'break_in',
  4: 'overtime_in',
  5: 'overtime_out',
  15: 'check_in',
  16: 'check_out',
};

/** Peta verify_mode dari mesin ke metode absen. */
const VERIFY_MODE = {
  0: 'sidik_jari',
  1: 'kartu',
  2: 'password',
  3: 'wajah',
  4: 'mesin',
  5: 'manual',
  15: 'sidik_jari',
  16: 'kartu',
  17: 'password',
  18: 'wajah',
};

/** Status rekap yang dipakai di laporan. */
const STATUS = {
  HADIR: 'hadir',
  TELAT: 'telat',
  IZIN: 'izin',
  SAKIT: 'sakit',
  CUTI: 'cuti',
  ALPA: 'alpa',
  BELUM: 'belum',
  HARI_LIBUR: 'hari_libur',
  DINAS_LUAR: 'dinas_luar',
  DINAS_DALAM: 'dinas_dalam',
};

/**
 * Status yang tetap dianggap "bekerja" oleh laporan rekap.
 * Dinas dalam/luar kota dihitung hadir karena tugas lapangan tetap owes jam kerja.
 */
const ATTENDED_STATUSES = ['hadir', 'telat', 'dinas_luar', 'dinas_dalam'];

const STATUS_LABEL = {
  hadir: 'Hadir',
  telat: 'Hadir (Telat)',
  izin: 'Izin',
  sakit: 'Sakit',
  cuti: 'Cuti',
  alpa: 'Alpa',
  belum: 'Belum Absen',
  hari_libur: 'Hari Libur',
  dinas_luar: 'Dinas Luar Kota',
  dinas_dalam: 'Dinas Dalam Kota',
};

// ---------------------------------------------------------------------------
// Query rekap
// ---------------------------------------------------------------------------

/**
 * Ambil log mentah seorang karyawan pada satu tanggal.
 * Log urut berdasarkan waktu agar ritik masuk/keluar bisa ditentukan.
 */
async function getLogsFor(employeeId, workDate) {
  return db.queryAll(
    `SELECT id, log_time, log_state, verify_mode, work_code, source, device_id
       FROM attendance_logs
      WHERE employee_id = ? AND log_date = ?
      ORDER BY log_time ASC, id ASC`,
    [employeeId, workDate]
  );
}

/**
 * Tentukan shift efektif untuk seorang karyawan pada tanggal tertentu.
 * Prioritas: jadwal di tabel schedules > shift default karyawan > null.
 */
async function resolveShift(employeeId, workDate) {
  const row = await db.queryOne(
    `SELECT s.day_type, s.note, s.shift_id AS override_shift_id,
            e.shift_id AS default_shift_id
       FROM employees e
       LEFT JOIN schedules s ON s.employee_id = e.id AND s.work_date = ?
      WHERE e.id = ?`,
    [workDate, employeeId]
  );

  if (!row) return { dayType: null, shift: null, scheduleNote: null, scheduled: false, source: 'none' };

  const shiftId = row.override_shift_id || row.default_shift_id;
  let shift = shiftId ? await shiftsService.getById(shiftId) : null;

  // Shift yang tertunjuk sudah ada tapi nonaktif: perlakukan seperti tidak ada
  // supaya fallback ke jam global tetap berlaku.
  if (shift && Number(shift.is_active) !== 1) shift = null;

  let source = 'none';
  if (shift) {
    source = row.override_shift_id ? 'schedule_shift' : 'employee_shift';
  } else {
    // Tidak ada shift sama sekali -> pakai Jam Kerja Global dari Pengaturan.
    shift = await getGlobalShift();
    if (shift) source = 'global';
  }

  return {
    // Jadwal per tanggal (bila ada) menggantikan shift default karyawan.
    dayType: row.day_type || null,
    shift,
    scheduleNote: row.note || null,
    scheduled: Boolean(row.override_shift_id),
    source,
  };
}

/**
 * Shift tiruan dari pengaturan Jam Kerja Global (menu Pengaturan).
 * Mengembalikan null bila fitur dimatikan atau jam global belum diisi.
 * Hasilnya di-cache supaya rekap ribuan baris tidak query settings terus.
 */
let globalShiftCache = null;

async function getGlobalShift() {
  if (!globalShiftCache) {
    const settings = await settingsService.getAll();
    globalShiftCache = settingsService.globalShiftFrom(settings);
  }
  return globalShiftCache;
}

/** Panggil setelah Pengaturan disimpan supaya jam global berikutnya terpakai. */
function invalidateGlobalShift() {
  globalShiftCache = null;
}

/** Ambil pengajuan izin/sakit/cuti yang sudah disetujui untuk tanggal tertentu. */
async function getApprovedLeave(employeeId, workDate) {
  return db.queryOne(
    `SELECT leave_type, subtype, place, reason, start_date, end_date
       FROM leave_requests
      WHERE employee_id = ?
        AND status = 'approved'
        AND ? BETWEEN start_date AND end_date
      ORDER BY start_date DESC
      LIMIT 1`,
    [employeeId, workDate]
  );
}

/**
 * Hitung rekap satu karyawan untuk satu tanggal.
 * Fungsi murni (tidak menyentuh DB selain pemanggilan di atas) supaya mudah
 * diuji.
 */
function computeDaily({
  employee,
  workDate,
  shift,
  dayType,
  logs,
  leave,
  duty = null,
  holiday = null,
  now = new Date(),
  shiftSource = null,
}) {
  // Rekap harian tidak menyimpan shift; shift hanya dipakai saat perhitungan.
  const isGlobal = Boolean(shift && shift.is_global);

  const result = {
    employeeId: employee.id,
    workDate,
    shiftSource: shiftSource || (isGlobal ? 'global' : shift ? 'shift' : 'none'),
    firstIn: null,
    firstOut: null,
    lateMinutes: 0,
    earlyMinutes: 0,
    workMinutes: 0,
    overtimeMinutes: 0,
    scanCount: logs.length,
    status: STATUS.BELUM,
    note: null,
  };

  // 1) Hari libur / tidak masuk shift
  if (dayType === 'libur') {
    result.status = STATUS.HARI_LIBUR;
    return result;
  }

  // 2) Absen dinas luar kota (bukan scan fingerprint, tapi GPS + selfie).
  //    Diprioritaskan sebelum leave karena tugas lapangan tetap dihitung kerja.
  if (duty) {
    result.status = STATUS.DINAS_LUAR;
    result.firstIn = duty.check_in_at;
    result.firstOut = duty.check_out_at;
    result.dutyId = duty.id;
    result.dutyNote = duty.note || null;

    // Durasi kerja dihitung dari jam portal; patokan shift dipakai bila shift
    // tersedia sehingga lembur tetap terukur seperti karyawan kantor.
    if (duty.check_in_at && (duty.check_out_at || logs.length > 0)) {
      const outAt = duty.check_out_at || lastOutTime(logs) || duty.check_in_at;
      result.workMinutes = Math.max(0, minutesBetween(outAt, duty.check_in_at));
      if (shift && shift.break_start && shift.break_end) {
        result.workMinutes = Math.max(0, result.workMinutes - breakDuration(shift, duty.check_in_at, outAt));
      }
      const maxWork = shiftsService.maxWorkMinutesOf(shift);
      const fullDay = shift ? shiftsService.shiftDurationMinutes(shift) : 0;
      const basis = fullDay > 0 ? fullDay : maxWork;
      if (basis > 0 && result.workMinutes > basis) {
        result.overtimeMinutes = result.workMinutes - basis;
      }
    }

    result.note = duty.note
      ? `Dinas luar kota. ${duty.note}`
      : 'Dinas luar kota (absen via GPS + selfie).';
    return result;
  }

  // 3) Pengajuan izin / sakit / cuti / dinas yang disetujui
  if (leave) {
    // Sub-jenis menentukan status (mis. cuti sakit -> status sakit). Pengajuan
    // lama yang belum punya subtype memakai peta leave_type bawaan.
    result.status = leaveCatalog.statusForLeave(leave.leave_type, leave.subtype);
    result.note = leaveNote(leave);
    // Tetap hitung jam kerja bila karyawan tetap scan (mis. izin sebagian hari).
    applyScans(result, logs, shift);
    return result;
  }

  // 4) Hari libur nasional / cuti bersama / libur tambahan dari admin.
  //    Diperiksa setelah dinas & pengajuan supaya tugas lapangan dan izin yang
  //    sudah disetujui tidak hilang statusnya di hari libur.
  if (holiday) {
    result.status = STATUS.HARI_LIBUR;
    result.note = holiday.name;
    // Kalau tetap ada scan di hari libur, tandai hadir tanpa penalti telat.
    if (logs.length > 0) {
      result.status = STATUS.HADIR;
      result.note = `Scan pada hari libur: ${holiday.name}`;
      applyScans(result, logs, null);
    }
    return result;
  }

  if (!shift) {
    // Tanpa shift, karyawan tetap bisa dihitung hadir berdasarkan scan pertama.
    // Tanpa scan sama sekali = alpa (tidak ada izin/cutti/dinas luar).
    if (logs.length === 0) {
      result.status = statusTanpaScan(workDate, now);
      return result;
    }
    result.status = STATUS.HADIR;
    applyScans(result, logs, null);
    return result;
  }

  if (!shiftsService.isWorkingDay(shift, workDate)) {
    result.status = STATUS.HARI_LIBUR;
    // Kalau tetap ada scan di hari libur, tandai hadir tanpa perhitungan telat.
    if (logs.length > 0) {
      result.status = STATUS.HADIR;
      result.note = 'Scan di luar hari kerja shift.';
      applyScans(result, logs, null);
    }
    return result;
  }

  // 5) Hari kerja: cari scan masuk pertama
  if (logs.length === 0) {
    result.status = statusTanpaScan(workDate, now);
    return result;
  }

  applyScans(result, logs, shift);

  if (result.firstIn) {
    const tolerance = shiftsService.toleranceOf(shift);
    const scheduledStart = timeToMinutes(shift.start_time, 0);
    const actualIn = timeToMinutes(String(formatDateTime(result.firstIn)).slice(11, 16), 0);

    // Shift lintas tengah malam: kalau scan masuk sebelum jam shift, itu
    // sebenarnya scan untuk shift hari sebelumnya.
    const late = actualIn - scheduledStart;
    result.lateMinutes = late > tolerance ? late : 0;
    result.status = result.lateMinutes > 0 ? STATUS.TELAT : STATUS.HADIR;
  } else {
    result.status = statusTanpaScan(workDate, now);
  }

  return result;
}

/**
 * Status hari kerja ketika karyawan tidak memindai sama sekali.
 *
 * Tidak ada scan + tidak ada izin/cutti/sakit + tidak ada dinas luar = ALPA.
 * ALPA baru ditetapkan setelah hari tersebut lewat, atau hari ini setelah
 * melewati jam cutoff. Hari ini sebelum cutoff masih "belum" supaya karyawan
 * yang belum sempat scan tidak langsung dianggap alpa.
 */
function statusTanpaScan(workDate, now) {
  if (workDate < today()) return STATUS.ALPA;

  if (workDate === today()) {
    const cutoff = config.attendance.cutoffMinutes;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return nowMinutes > cutoff ? STATUS.ALPA : STATUS.BELUM;
  }

  return STATUS.BELUM;
}

/**
 * Catatan rekap untuk pengajuan yang disetujui.
 * Memuat nama sub-jenis (mis. "Cuti Melahirkan") dan lokasi dinas supaya
 * laporan bisa dibaca tanpa melihat tabel pengajuan.
 */
function leaveNote(leave) {
  const label = leaveCatalog.labelForLeave(leave.leave_type, leave.subtype);
  const parts = [];
  if (leave.subtype) parts.push(label);
  if (leave.place) parts.push(`Lokasi: ${leave.place}`);
  if (leave.reason) parts.push(leave.reason);
  return parts.length > 0 ? parts.join(' - ') : null;
}

/** Hitung first_in, first_out, dan durasi kerja dari daftar log. */
function applyScans(result, logs, shift) {
  if (logs.length === 0) return;

  // Scan masuk: ambil log paling awal. Bila scan pertama jauh sebelum jam
  // shift, tetap dipakai sebagai first_in.
  const ins = logs.filter((l) => isIn(l));
  const outs = logs.filter((l) => isOut(l));

  if (ins.length > 0) {
    result.firstIn = formatDateTime(ins[0].log_time);
  } else {
    // Tidak ada scan masuk eksplisit: pakai scan pertama apa saja.
    result.firstIn = formatDateTime(logs[0].log_time);
  }

  if (outs.length > 0) {
    result.firstOut = formatDateTime(outs[outs.length - 1].log_time);
  } else if (logs.length > 1) {
    // Tidak ada scan keluar: pakai scan terakhir.
    result.firstOut = formatDateTime(logs[logs.length - 1].log_time);
  }

  if (result.firstIn && result.firstOut) {
    const total = minutesBetween(result.firstOut, result.firstIn);

    // Kurangi waktu istirahat shift.
    let effective = total;
    if (shift && shift.break_start && shift.break_end) {
      effective -= breakDuration(shift, result.firstIn, result.firstOut);
    }
    result.workMinutes = Math.max(0, effective);

    if (shift) {
      const maxWork = shiftsService.maxWorkMinutesOf(shift);
      const fullDay = shiftsService.shiftDurationMinutes(shift);
      const basis = fullDay > 0 ? fullDay : maxWork;
      if (result.workMinutes > basis) {
        result.overtimeMinutes = result.workMinutes - basis;
      }

      // Pulang sebelum jam selesai. Hanya relevan bila selisihnya positif,
      // yaitu benar-benar pulang lebih cepat (bukan lembur).
      if (result.overtimeMinutes === 0) {
        const start = timeToMinutes(shift.start_time, 0);
        const end = timeToMinutes(shift.end_time, 0);
        const overnight = end <= start;
        const actualOut = timeToMinutes(String(result.firstOut).slice(11, 16), 0);

        let early = end - actualOut;
        // Shift lintas tengah malam: jam selesai dihitung relatif terhadap
        // pergantian hari, jadi jam keluar yang lebih kecil berarti keesokan hari.
        if (overnight && early < 0) early += 1440;

        // Toleransi 60 menit: tidak terlalu cerewet soal selisih kecil.
        if (early > 60) {
          result.earlyMinutes = early;
        }
      }
    }
  }
}

/** Jam scan terakhir yang bertanda check-out, atau null bila tidak ada. */
function lastOutTime(logs) {
  const outs = (logs || []).filter((l) => isOut(l));
  if (outs.length === 0) return null;
  return formatDateTime(outs[outs.length - 1].log_time);
}

function breakDuration(shift, firstIn, firstOut) {
  const breakStart = timeToMinutes(shift.break_start, 0);
  const breakEnd = timeToMinutes(shift.break_end, 0);
  if (breakEnd <= breakStart) return breakEnd - breakStart + 1440;
  return breakEnd - breakStart;
}

function minutesBetween(later, earlier) {
  const a = new Date(String(later).replace(' ', 'T'));
  const b = new Date(String(earlier).replace(' ', 'T'));
  return Math.max(0, Math.round((a - b) / 60000));
}

function isIn(log) {
  const state = Number(log.log_state);
  return state === 0 || state === 15 || state === 4;
}

function isOut(log) {
  const state = Number(log.log_state);
  return state === 1 || state === 16 || state === 5;
}

// ---------------------------------------------------------------------------
// Generate / persist rekap
// ---------------------------------------------------------------------------

// Query ditulis sebagai dua bagian supaya pemanggil bisa menyisipkan daftar
// VALUES (...) sebanyak jumlah baris pada batch.
const UPSERT_SQL_PREFIX = `
  INSERT INTO attendance_daily
      (employee_id, work_date, first_in, first_out,
     late_minutes, early_minutes, work_minutes, overtime_minutes,
     scan_count, status, note, is_auto)
  VALUES`;

const UPSERT_SQL_SUFFIX = `
  ON DUPLICATE KEY UPDATE
    first_in = VALUES(first_in),
    first_out = VALUES(first_out),
    late_minutes = VALUES(late_minutes),
    early_minutes = VALUES(early_minutes),
    work_minutes = VALUES(work_minutes),
    overtime_minutes = VALUES(overtime_minutes),
    scan_count = VALUES(scan_count),
    status = IF(is_auto = 1, VALUES(status), status),
    note = IF(is_auto = 1, VALUES(note), note),
    generated_at = NOW()
`;

/**
 * Bangun rekap untuk seluruh karyawan pada rentang tanggal.
 * Mengembalikan jumlah baris yang diproses.
 */
async function generate({ from, to, employeeId = null, departmentId = null, force = false } = {}) {
  const startDate = toDate(from) || today();
  const endDate = toDate(to) || startDate;
  const dates = dateRange(startDate, endDate);

  if (dates.length === 0) throw new Error('Rentang tanggal tidak valid.');
  if (dates.length > 400) {
    throw new Error('Rentang terlalu lebar (maksimal 400 hari). Jalankan per bulan atau per kuartal.');
  }

  // Ambil karyawan aktif beserta shift default-nya.
  const where = ["e.status <> 'resign'"];
  const params = [];
  if (employeeId) {
    where.push('e.id = ?');
    params.push(employeeId);
  }
  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(departmentId);
  }

  const employees = await db.queryAll(
    `SELECT e.id, e.name, e.employee_code, e.shift_id, e.status, e.hire_date
       FROM employees e
      WHERE ${where.join(' AND ')}
      ORDER BY e.id ASC`,
    params
  );

  if (employees.length === 0) {
    return { processed: 0, employees: 0, days: dates.length, message: 'Tidak ada karyawan yang perlu direkap.' };
  }

  // Cache agar tidak query berulang untuk shift / jadwal / izin yang sama.
  const shiftCache = new Map();
  const logsCache = new Map();
  const leaveCache = new Map();
  const dutyCache = new Map();

  // Peta hari libur sekali untuk seluruh rentang, bukan per karyawan per tanggal.
  const holidayMap = await holidaysService.getHolidayMap(startDate, endDate);

  const rows = [];
  const now = new Date();

  for (const employee of employees) {
    // Jangan rekap sebelum tanggal masuk karyawan.
    if (employee.hire_date && toDate(employee.hire_date) > startDate) continue;

    for (const workDate of dates) {
      const resolved = await getResolvedCached(employee.id, workDate, shiftCache);
      const logs = await getLogsCached(employee.id, workDate, logsCache);
      const leave = await getLeaveCached(employee.id, workDate, leaveCache);
      const duty = await getDutyCached(employee.id, workDate, dutyCache);

      const computed = computeDaily({
        employee,
        workDate,
        shift: resolved.shift,
        dayType: resolved.dayType,
        logs,
        leave,
        duty,
        holiday: holidayMap.get(workDate) || null,
        now,
        shiftSource: resolved.source,
      });

      rows.push([
        computed.employeeId,
        computed.workDate,
        computed.firstIn,
        computed.firstOut,
        computed.lateMinutes,
        computed.earlyMinutes,
        computed.workMinutes,
        computed.overtimeMinutes,
        computed.scanCount,
        computed.status,
        computed.note,
      ]);
    }
  }

  if (rows.length === 0) {
    return { processed: 0, employees: employees.length, days: dates.length, message: 'Tidak ada baris yang perlu direkap.' };
  }

  // Tulis per batch supaya tidak mengunci tabel terlalu lama.
  const BATCH = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    // 11 placeholder per baris + literal 1 untuk kolom is_auto.
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,1)').join(', ');
    // executeLarge memakai mode non-prepared supaya jumlah placeholder yang
    // banyak tidak memicu "Malformed communication packet" dari MariaDB.
    await db.executeLarge(`${UPSERT_SQL_PREFIX} ${placeholders} ${UPSERT_SQL_SUFFIX}`, slice.flat());
    written += slice.length;
  }

  void force;
  return {
    processed: written,
    employees: employees.length,
    days: dates.length,
    from: startDate,
    to: endDate,
    message: `${written} baris rekap dibuat untuk ${employees.length} karyawan.`,
  };
}

/** Cache hasil resolveShift per (karyawan, tanggal) supaya tidak query berulang. */
async function getResolvedCached(employeeId, workDate, cache) {
  const key = `${employeeId}:${workDate}`;
  if (!cache.has(key)) {
    cache.set(key, await resolveShift(employeeId, workDate));
  }
  return cache.get(key);
}

async function getLogsCached(employeeId, workDate, cache) {
  const key = `${employeeId}:${workDate}`;
  if (cache.has(key)) return cache.get(key);
  const logs = await getLogsFor(employeeId, workDate);
  cache.set(key, logs);
  return logs;
}

async function getLeaveCached(employeeId, workDate, cache) {
  const key = `${employeeId}:${workDate}`;
  if (cache.has(key)) return cache.get(key);
  const leave = await getApprovedLeave(employeeId, workDate);
  cache.set(key, leave);
  return leave;
}

/** Absen dinas luar kota pada tanggal tertentu, atau null. */
async function getDutyCheckin(employeeId, workDate) {
  return db.queryOne(
    `SELECT id, employee_id, work_date, check_in_at, check_out_at,
            latitude, longitude, accuracy_m, address, selfie_path, note, leave_id
       FROM duty_checkins
      WHERE employee_id = ? AND work_date = ?`,
    [employeeId, workDate]
  );
}

async function getDutyCached(employeeId, workDate, cache) {
  const key = `${employeeId}:${workDate}`;
  if (cache.has(key)) return cache.get(key);
  const duty = await getDutyCheckin(employeeId, workDate);
  cache.set(key, duty);
  return duty;
}

/** Rekap hanya satu karyawan untuk satu tanggal (dipakai setelah sinkron PUSH). */
async function generateForEmployee(employeeId, workDate) {
  return generate({ from: workDate, to: workDate, employeeId });
}

/** Rekap ulang semua log yang masuk dalam N hari terakhir. */
async function backfill(days = config.attendance.backfillDays) {
  const from = addDays(today(), -(Math.max(1, days) - 1));
  return generate({ from, to: today() });
}

// ---------------------------------------------------------------------------
// Pembacaan rekap
// ---------------------------------------------------------------------------

/** Ambil rekap harian dengan filter, untuk tabel di UI dan laporan. */
async function list(query = {}) {
  const { page, perPage, offset } = (() => {
    const p = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const pp = Math.min(500, Math.max(1, Number.parseInt(query.per_page || query.perPage || 25, 10) || 25));
    return { page: p, perPage: pp, offset: (p - 1) * pp };
  })();

  const where = [];
  const params = [];

  const from = toDate(query.from);
  const to = toDate(query.to);
  if (from) {
    where.push('d.work_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('d.work_date <= ?');
    params.push(to);
  }

  if (query.status) {
    const statuses = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      where.push(`d.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
  }

  if (query.employee_id) {
    where.push('d.employee_id = ?');
    params.push(Number(query.employee_id));
  }
  if (query.department_id) {
    where.push('e.department_id = ?');
    params.push(Number(query.department_id));
  }
  if (query.only_late === '1' || query.only_late === true || query.only_late === 'true') {
    where.push('d.late_minutes > 0');
  }

  const search = query.search ? String(query.search).trim() : '';
  if (search) {
    where.push('(e.name LIKE ? OR e.employee_code LIKE ? OR e.device_user_id LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    FROM attendance_daily d
    JOIN employees e ON e.id = d.employee_id
    LEFT JOIN departments dep ON dep.id = e.department_id
    LEFT JOIN positions pos ON pos.id = e.position_id
    ${whereSql}
  `;

  const total = await db.queryScalar(`SELECT COUNT(*) ${base}`, params);

  const rows = await db.queryAll(
    `SELECT
       d.id, d.employee_id, e.employee_code, e.name AS employee_name, e.device_user_id,
       dep.name AS department_name, pos.name AS position_name,
       d.work_date,
       d.first_in, d.first_out, d.late_minutes, d.early_minutes,
       d.work_minutes, d.overtime_minutes, d.scan_count, d.status, d.is_auto, d.note
     ${base}
     ORDER BY d.work_date DESC, e.name ASC
     LIMIT ? OFFSET ?`,
    [...params, perPage, offset]
  );

  return {
    data: rows,
    meta: {
      total: Number(total || 0),
      page,
      per_page: perPage,
      total_pages: perPage > 0 ? Math.ceil(Number(total || 0) / perPage) : 0,
    },
  };
}

/** Ambil rekap satu karyawan pada satu tanggal, lengkap dengan log mentahnya. */
async function getOne(employeeId, workDate) {
  const date = toDate(workDate) || today();
  const daily = await db.queryOne(
    `SELECT d.*, e.name AS employee_name, e.employee_code, e.device_user_id
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.employee_id = ? AND d.work_date = ?`,
    [employeeId, date]
  );

  const shift = await resolveShift(employeeId, date);
  const duty = await getDutyCheckin(employeeId, date);
  const holiday = await holidaysService.getByDate(date);

  const logs = await db.queryAll(
    `SELECT l.id, l.log_time, l.log_state, l.verify_mode, l.work_code, l.source,
            d.name AS device_name
       FROM attendance_logs l
       LEFT JOIN devices d ON d.id = l.device_id
      WHERE l.employee_id = ? AND l.log_date = ?
      ORDER BY l.log_time ASC`,
    [employeeId, date]
  );

  return {
    daily: daily || null,
    duty: duty || null,
    holiday: holiday || null,
    shift: shift.shift
      ? {
          shift_code: shift.shift.code,
          name: shift.shift.name,
          start_time: shift.shift.start_time,
          end_time: shift.shift.end_time,
          break_start: shift.shift.break_start,
          break_end: shift.shift.break_end,
          late_tolerance_min: shift.shift.late_tolerance_min,
        }
      : null,
    day_type: shift.dayType,
    logs: logs.map((l) => ({
      ...l,
      log_state_label: LOG_STATE[Number(l.log_state)] || `state_${l.log_state}`,
      verify_mode_label: VERIFY_MODE[Number(l.verify_mode)] || `mode_${l.verify_mode}`,
    })),
  };
}

/** Ringkasan statistik untuk dashboard. */
async function summary({ from, to, departmentId = null } = {}) {
  const start = toDate(from) || today();
  const end = toDate(to) || start;

  const where = ['d.work_date BETWEEN ? AND ?'];
  const params = [start, end];
  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byStatus = await db.queryAll(
    `SELECT d.status, COUNT(*) AS total
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
     ${whereSql}
      GROUP BY d.status`,
    params
  );

  const totals = await db.queryOne(
    `SELECT
       COUNT(DISTINCT d.employee_id) AS employees,
       SUM(d.late_minutes) AS total_late_minutes,
       AVG(NULLIF(d.late_minutes, 0)) AS avg_late_minutes,
       SUM(d.work_minutes) AS total_work_minutes,
       SUM(d.overtime_minutes) AS total_overtime_minutes,
       AVG(NULLIF(d.work_minutes, 0)) AS avg_work_minutes,
       SUM(d.scan_count) AS total_scans
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     ${whereSql}`,
    params
  );

  const perDay = await db.queryAll(
    `SELECT d.work_date,
            SUM(d.status = 'hadir') AS hadir,
            SUM(d.status = 'telat') AS telat,
            SUM(d.status = 'izin') AS izin,
            SUM(d.status = 'sakit') AS sakit,
            SUM(d.status = 'cuti') AS cuti,
             SUM(d.status = 'dinas_luar') AS dinas_luar,
             SUM(d.status = 'dinas_dalam') AS dinas_dalam,
             SUM(d.status = 'alpa') AS alpa,
            SUM(d.status = 'belum') AS belum,
            SUM(d.status = 'hari_libur') AS hari_libur
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
     ${whereSql}
      GROUP BY d.work_date
      ORDER BY d.work_date ASC`,
    params
  );

  const statusMap = {};
  for (const row of byStatus) {
    statusMap[row.status] = Number(row.total);
    statusMap[`${row.status}_label`] = STATUS_LABEL[row.status] || row.status;
  }

  // Kolom "Total" per hari dipakai tabel ringkasan di UI dan sheet ekspor,
  // jadi harus dihitung di sini agar kedua keluaran konsisten.
  const PER_DAY_KEYS = ['hadir', 'telat', 'izin', 'sakit', 'cuti', 'dinas_luar', 'dinas_dalam', 'alpa', 'belum', 'hari_libur'];
  const perDayWithTotal = perDay.map((row) => {
    const total = PER_DAY_KEYS.reduce((sum, key) => sum + Number(row[key] || 0), 0);
    return { ...row, total };
  });

  return {
    range: { from: start, to: end },
    by_status: statusMap,
    totals: {
      employees: Number(totals?.employees || 0),
      total_late_minutes: Number(totals?.total_late_minutes || 0),
      avg_late_minutes: Math.round(Number(totals?.avg_late_minutes || 0)),
      total_work_minutes: Number(totals?.total_work_minutes || 0),
      avg_work_minutes: Math.round(Number(totals?.avg_work_minutes || 0)),
      total_overtime_minutes: Number(totals?.total_overtime_minutes || 0),
      total_scans: Number(totals?.total_scans || 0),
    },
    per_day: perDayWithTotal,
  };
}

/** Rekap per karyawan untuk satu tanggal - dipakai layar "absensi hari ini". */
async function todayBoard({ date = null, departmentId = null } = {}) {
  const workDate = toDate(date) || today();
  return list({
    from: workDate,
    to: workDate,
    department_id: departmentId,
    per_page: 500,
  });
}

/** Koreksi manual satu baris rekap (mis. ada karyawan yang lupa absen). */
async function override(employeeId, workDate, { status, note, isAuto = false } = {}) {
  const date = toDate(workDate);
  if (!date) throw new Error('work_date tidak valid.');

  const allowed = Object.values(STATUS);
  if (!allowed.includes(status)) {
    throw new Error(`status tidak valid. Pilihan: ${allowed.join(', ')}.`);
  }

  const existing = await db.queryOne(
    'SELECT id FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
    [employeeId, date]
  );

  if (!existing) {
    // Belum ada rekap: buat baru dari log yang ada.
    await generateForEmployee(employeeId, date);
  }

  await db.execute(
    'UPDATE attendance_daily SET status = ?, note = ?, is_auto = ? WHERE employee_id = ? AND work_date = ?',
    [status, note || null, isAuto ? 1 : 0, employeeId, date]
  );

  return getOne(employeeId, date);
}

/** Daftar Presence mentah (untuk audit / export). */
async function rawLogs({ from, to, employeeId = null, deviceId = null, limit = 1000, offset = 0 } = {}) {
  const where = [];
  const params = [];

  const start = toDate(from);
  const finish = toDate(to);
  if (start) {
    where.push('l.log_date >= ?');
    params.push(start);
  }
  if (finish) {
    where.push('l.log_date <= ?');
    params.push(finish);
  }
  if (employeeId) {
    where.push('l.employee_id = ?');
    params.push(Number(employeeId));
  }
  if (deviceId) {
    where.push('l.device_id = ?');
    params.push(Number(deviceId));
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const max = Math.min(50000, Math.max(1, Number(limit) || 1000));

  return db.queryAll(
    `SELECT l.id, l.log_time, l.log_state, l.verify_mode, l.work_code, l.source,
            l.employee_id, e.name AS employee_name, e.employee_code, e.device_user_id,
            dev.name AS device_name
       FROM attendance_logs l
       LEFT JOIN employees e ON e.id = l.employee_id
       LEFT JOIN devices dev ON dev.id = l.device_id
     ${whereSql}
      ORDER BY l.log_time DESC
      LIMIT ${max} OFFSET ${Math.max(0, Number(offset) || 0)}`,
    params
  );
}

module.exports = {
  LOG_STATE,
  VERIFY_MODE,
  STATUS,
  STATUS_LABEL,
  ATTENDED_STATUSES,
  computeDaily,
  generate,
  generateForEmployee,
  backfill,
  list,
  getOne,
  summary,
  todayBoard,
  override,
  rawLogs,
  resolveShift,
  getGlobalShift,
  invalidateGlobalShift,
  getDutyCheckin,
  minutesToTime,
  isoDayOfWeek,
};
