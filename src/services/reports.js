'use strict';

const ExcelJS = require('exceljs');

const db = require('../db/pool');
const attendanceService = require('./attendance');
const { today, startOfMonth, endOfMonth, toDate, longDate, formatTime, monthName } = require('../utils/date');
const { badRequest } = require('../utils/errors');

/**
 * Laporan & ekspor.
 *
 * Format yang tersedia:
 *  - rekap_harian : satu baris per karyawan per tanggal
 *  - rekap_bulanan: satu baris per karyawan untuk satu bulan
 *  - log_mentah   : seluruh scan dari mesin
 *  - ringkasan    : statistik per hari
 */

/**
 * Daftar format laporan yang didukung.
 *
 * `key` dipakai sebagai nilai query `format`, `label` ditampilkan di dropdown
 * UI, dan `scope` memberi tahu kelompok filter mana yang relevan supaya
 * frontend bisa menyembunyikan filter yang tidak berlaku.
 *
 * Daftar ini adalah sumber kebenaran tunggal: endpoint /api/reports/formats memakai
 * daftar ini langsung, sehingga format yang bisa dipilih di UI selalu sama
 * dengan yang benar-benar bisa dijalankan.
 */
const FORMAT_LIST = [
  {
    key: 'rekap_harian',
    label: 'Rekap Harian (per karyawan per tanggal)',
    scope: 'range',
    hint: 'Satu baris per karyawan per tanggal, lengkap dengan jam masuk, jam pulang, dan keterlambatan.',
  },
  {
    key: 'rekap_bulanan',
    label: 'Rekap Bulanan (per karyawan)',
    scope: 'month',
    hint: 'Rekap satu bulan penuh per karyawan, termasuk persentase kehadiran.',
  },
  {
    key: 'per_karyawan',
    label: 'Rekap per Karyawan (ringkas)',
    scope: 'month',
    hint: 'Ringkasan singkat per karyawan untuk Evaluasi Kinerja.',
  },
  {
    key: 'lembur',
    label: 'Lembur per Karyawan',
    scope: 'range',
    hint: 'Hanya karyawan yang punya lembur, diurutkan dari yang paling banyak.',
  },
  {
    key: 'rekap_kehadiran',
    label: 'Rekap Kehadiran per Karyawan',
    scope: 'range',
    hint: 'Like matrix hadir/telat/izin/alpa per karyawan per tanggal.',
  },
  {
    key: 'ringkasan',
    label: 'Ringkasan per Hari',
    scope: 'range',
    hint: 'Jumlah hadir, telat, izin, sakit, alpa per tanggal untuk seluruh perusahaan.',
  },
  {
    key: 'log_mentah',
    label: 'Log Absensi Mentah (seluruh scan)',
    scope: 'range',
    hint: 'Setiap scan yang masuk dari mesin, termasuk scan yang tidak terhubung ke master karyawan.',
  },
];

const FORMATS = FORMAT_LIST.map((f) => f.key);

// Format yang difilter per bulan (bukan rentang tanggal).
const MONTH_FORMATS = ['rekap_bulanan', 'per_karyawan'];

// ---------------------------------------------------------------------------
// Pengambilan data
// ---------------------------------------------------------------------------

async function buildDailyRows({ from, to, departmentId = null, employeeId = null, status = null }) {
  const where = ['d.work_date BETWEEN ? AND ?'];
  const params = [from, to];

  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }
  if (employeeId) {
    where.push('d.employee_id = ?');
    params.push(Number(employeeId));
  }
  if (status) {
    const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) {
      where.push(`d.status IN (${list.map(() => '?').join(', ')})`);
      params.push(...list);
    }
  }

  return db.queryAll(
    `SELECT
       e.employee_code, e.device_user_id, e.name AS employee_name,
       dep.name AS department_name, pos.name AS position_name,
       d.work_date,
       d.first_in, d.first_out, d.late_minutes, d.early_minutes,
       d.work_minutes, d.overtime_minutes, d.scan_count, d.status, d.note
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id
     LEFT JOIN positions pos ON pos.id = e.position_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.name ASC, d.work_date ASC`,
    params
  );
}

/**
 * Rekap satu bulan per karyawan: total hadir/telat/izin/alpa, total jam kerja,
 * total lembur, dan rata-rata keterlambatan.
 */
async function buildMonthlyRows({ month, departmentId = null, employeeId = null }) {
  const from = `${month}-01`;
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;

  const where = ['d.work_date BETWEEN ? AND ?'];
  const params = [from, to];

  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }
  if (employeeId) {
    where.push('d.employee_id = ?');
    params.push(Number(employeeId));
  }

  return db.queryAll(
    `SELECT
       e.id AS employee_id, e.employee_code, e.name AS employee_name, e.device_user_id,
       dep.name AS department_name, pos.name AS position_name,
       COUNT(*) AS total_days,
       SUM(d.status = 'hadir') AS total_hadir,
       SUM(d.status = 'telat') AS total_telat,
       SUM(d.status = 'izin') AS total_izin,
       SUM(d.status = 'sakit') AS total_sakit,
       SUM(d.status = 'cuti') AS total_cuti,
       SUM(d.status = 'dinas_luar') AS total_dinas_luar,
       SUM(d.status = 'dinas_dalam') AS total_dinas_dalam,
       SUM(d.status = 'alpa') AS total_alpa,
       SUM(d.status = 'belum') AS total_belum,
       SUM(d.status = 'hari_libur') AS total_libur,
       SUM(d.late_minutes) AS total_late_minutes,
       AVG(NULLIF(d.late_minutes, 0)) AS avg_late_minutes,
       MAX(d.late_minutes) AS max_late_minutes,
       SUM(d.work_minutes) AS total_work_minutes,
       SUM(d.overtime_minutes) AS total_overtime_minutes
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id
     LEFT JOIN positions pos ON pos.id = e.position_id
     WHERE ${where.join(' AND ')}
     GROUP BY e.id, e.employee_code, e.name, e.device_user_id, dep.name, pos.name
     ORDER BY e.name ASC`,
    params
  );
}

/**
 * Rekap kehadiran karyawan: total hari kerja, kehadiran, izin, cuti,
 * dinas luar, keterlambatan, dan lembur per karyawan dalam periode tertentu.
 */
async function buildAttendanceRecapRows({ from, to, departmentId = null, employeeId = null }) {
  const where = ['d.work_date BETWEEN ? AND ?'];
  const params = [from, to];

  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }
  if (employeeId) {
    where.push('d.employee_id = ?');
    params.push(Number(employeeId));
  }

  return db.queryAll(
    `SELECT
       e.employee_code,
       e.name AS employee_name,
       dep.name AS department_name,
       pos.name AS position_name,
       SUM(d.status <> 'hari_libur') AS total_hari_kerja,
       SUM(d.status IN ('hadir', 'telat', 'dinas_luar', 'dinas_dalam')) AS total_hadir,
       SUM(d.status = 'izin') AS total_izin,
       SUM(d.status = 'cuti') AS total_cuti,
       SUM(d.status = 'dinas_luar') AS total_dinas_luar,
       SUM(d.status = 'dinas_dalam') AS total_dinas_dalam,
       SUM(d.status = 'telat') AS total_hari_terlambat,
       SUM(d.overtime_minutes) AS total_overtime_minutes
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id
     LEFT JOIN positions pos ON pos.id = e.position_id
     WHERE ${where.join(' AND ')}
     GROUP BY e.id, e.employee_code, e.name, dep.name, pos.name
     ORDER BY e.name ASC`,
    params
  );
}

/**
 * Laporan lembur per karyawan.
 * Rekap harian tidak menyimpan shift, jadi angka lembur diambil dari kolom
 * `overtime_minutes` yang sudah dihitung saat rekap (dengan patokan shift
 * karyawan, jadwal harian, atau jam kerja global).
 */
async function buildOvertimeRows({ from, to, departmentId = null, employeeId = null }) {
  const where = ['d.work_date BETWEEN ? AND ?', 'd.overtime_minutes > 0'];
  const params = [from, to];

  if (departmentId) {
    where.push('e.department_id = ?');
    params.push(Number(departmentId));
  }
  if (employeeId) {
    where.push('d.employee_id = ?');
    params.push(Number(employeeId));
  }

  return db.queryAll(
    `SELECT
       e.id AS employee_id, e.employee_code, e.name AS employee_name,
       dep.name AS department_name, pos.name AS position_name,
       COUNT(*) AS days_with_overtime,
       SUM(d.overtime_minutes) AS total_overtime_minutes,
       MAX(d.overtime_minutes) AS max_overtime_minutes
     FROM attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN departments dep ON dep.id = e.department_id
     LEFT JOIN positions pos ON pos.id = e.position_id
     WHERE ${where.join(' AND ')}
     GROUP BY e.id, e.employee_code, e.name, dep.name, pos.name
     HAVING total_overtime_minutes > 0
     ORDER BY total_overtime_minutes DESC`,
    params
  );
}

// ---------------------------------------------------------------------------
// Format laporan
// ---------------------------------------------------------------------------

/**
 * Susun objek laporan lengkap (dipakai untuk pratinjau di UI maupun ekspor).
 */
async function build(format, options = {}) {
  // Format berbasis bulan memakai rentang bulan tersebut; format lain memakai
  // from/to. month diutamakan karena UI menyembunyikan kolom tanggal untuknya.
  const useMonth = MONTH_FORMATS.includes(format) && typeof options.month === 'string';
  const month = useMonth ? options.month : null;
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw badRequest('month harus format YYYY-MM.');

  const from = useMonth ? `${month}-01` : toDate(options.from) || startOfMonth();
  const to = useMonth ? endOfMonth(`${month}-01`) : toDate(options.to) || today();

  if (format === 'rekap_harian') {
    const rows = await buildDailyRows({ ...options, from, to });
    return {
      format,
      range: { from, to },
      rows: rows.map(decorateDailyRow),
      columns: DAILY_COLUMNS,
      meta: { total: rows.length },
    };
  }

  if (format === 'rekap_bulanan') {
    const rows = await buildMonthlyRows({ ...options, month: month || from.slice(0, 7) });
    return {
      format,
      range: { month: month || from.slice(0, 7), from, to },
      rows: rows.map(decorateMonthlyRow),
      columns: MONTHLY_COLUMNS,
      meta: { total: rows.length },
    };
  }

  if (format === 'log_mentah') {
    const rows = await attendanceService.rawLogs({
      from,
      to,
      employeeId: options.employee_id,
      deviceId: options.device_id,
      limit: options.limit || 50000,
      offset: 0,
    });
    return {
      format,
      range: { from, to },
      rows: rows.map((r) => ({
        ...r,
        log_time_text: r.log_time,
        jam: formatTime(r.log_time),
        metode: attendanceService.VERIFY_MODE[Number(r.verify_mode)] || r.verify_mode,
        state_label: attendanceService.LOG_STATE[Number(r.log_state)] || r.log_state,
      })),
      columns: RAW_COLUMNS,
      meta: { total: rows.length },
    };
  }

  if (format === 'per_karyawan') {
    const summary = await attendanceService.summary({ from, to, departmentId: options.department_id });
    const detail = await buildDailyRows({ from, to, departmentId: options.department_id, employeeId: options.employee_id, status: options.status });
    const byEmployee = new Map();

    for (const row of detail) {
      if (!byEmployee.has(row.employee_name + row.employee_code)) {
        byEmployee.set(row.employee_name + row.employee_code, {
          employee_code: row.employee_code,
          employee_name: row.employee_name,
          department_name: row.department_name,
          hari_kerja: 0,
          hadir: 0,
          telat: 0,
          izin: 0,
          sakit: 0,
          dinas_luar: 0,
          dinas_dalam: 0,
          alpa: 0,
          total_late_minutes: 0,
          total_work_minutes: 0,
        });
      }
      const bucket = byEmployee.get(row.employee_name + row.employee_code);
      if (row.status === 'hari_libur') continue;
      bucket.hari_kerja += 1;
      if (bucket[row.status] !== undefined) bucket[row.status] += 1;
      // Dinas dalam/luar dihitung sebagai kehadiran: tugas tetap jam kerja.
      // Telat ikut dihitung hadir supaya % hadir konsisten dengan bulanan.
      if (row.status === 'dinas_luar' || row.status === 'dinas_dalam') bucket.hadir += 1;
      if (row.status === 'telat') bucket.hadir += 1;
      bucket.total_late_minutes += Number(row.late_minutes || 0);
      bucket.total_work_minutes += Number(row.work_minutes || 0);
    }

    return {
      format,
      range: { from, to },
      rows: [...byEmployee.values()].map((r) => ({
        ...r,
        persen_hadir: r.hari_kerja > 0 ? Math.round((r.hadir / r.hari_kerja) * 100) : 0,
      })),
      columns: EMPLOYEE_COLUMNS,
      meta: { total: byEmployee.size, summary },
    };
  }

  if (format === 'ringkasan') {
    const summary = await attendanceService.summary({ from, to, departmentId: options.department_id });
    return {
      format,
      range: { from, to },
      rows: summary.per_day,
      summary,
      columns: SUMMARY_COLUMNS,
      meta: { total: summary.per_day.length },
    };
  }

  if (format === 'lembur') {
    const rows = await buildOvertimeRows({ ...options, from, to });
    return {
      format,
      range: { from, to },
      rows: rows.map(decorateOvertimeRow),
      columns: OVERTIME_COLUMNS,
      meta: { total: rows.length },
    };
  }

  if (format === 'rekap_kehadiran') {
    const rows = await buildAttendanceRecapRows({ ...options, from, to });
    return {
      format,
      range: { from, to },
      rows: rows.map(decorateAttendanceRecapRow),
      columns: ATTENDANCE_RECAP_COLUMNS,
      meta: { total: rows.length },
    };
  }

  throw badRequest(`format "${format}" tidak dikenali. Pilihan: ${FORMATS.join(', ')}.`);
}

function decorateDailyRow(row) {
  return {
    ...row,
    tanggal: row.work_date,
    hari: longDate(row.work_date),
    jam_masuk: formatTime(row.first_in),
    jam_keluar: formatTime(row.first_out),
    menit_terlambat: Number(row.late_minutes || 0),
    jam_kerja: (Number(row.work_minutes || 0) / 60).toFixed(2),
    jam_lembur: (Number(row.overtime_minutes || 0) / 60).toFixed(2),
    menit_pulang_cepat: Number(row.early_minutes || 0),
    status_label: attendanceService.STATUS_LABEL[row.status] || row.status,
  };
}

function decorateMonthlyRow(row) {
  const hadirDays =
    Number(row.total_hadir || 0) +
    Number(row.total_telat || 0) +
    Number(row.total_dinas_luar || 0) +
    Number(row.total_dinas_dalam || 0);
  const workDays = Math.max(
    1,
    Number(row.total_days || 0) - Number(row.total_libur || 0)
  );
  return {
    ...row,
    employee_name: row.employee_name,
    persen_hadir: hadirDays > 0 ? Math.round((hadirDays / workDays) * 100) : 0,
    rata_late_jam: (Number(row.avg_late_minutes || 0) / 60).toFixed(2),
    total_kerja_jam: (Number(row.total_work_minutes || 0) / 60).toFixed(2),
    total_lembur_jam: (Number(row.total_overtime_minutes || 0) / 60).toFixed(2),
  };
}

function decorateOvertimeRow(row) {
  return {
    ...row,
    total_overtime_jam: (Number(row.total_overtime_minutes || 0) / 60).toFixed(2),
    max_overtime_jam: (Number(row.max_overtime_minutes || 0) / 60).toFixed(2),
  };
}

function decorateAttendanceRecapRow(row) {
  return {
    ...row,
    no_urut: 0,
    total_lembur_jam: (Number(row.total_overtime_minutes || 0) / 60).toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Kolom untuk ekspor Excel
// ---------------------------------------------------------------------------

const DAILY_COLUMNS = [
  { key: 'employee_code', header: 'Kode Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Departemen', width: 20 },
  { key: 'position_name', header: 'Jabatan', width: 18 },
  { key: 'tanggal', header: 'Tanggal', width: 13 },
  { key: 'hari', header: 'Hari', width: 26 },
  { key: 'jam_masuk', header: 'Jam Masuk', width: 12 },
  { key: 'jam_keluar', header: 'Jam Keluar', width: 13 },
  { key: 'menit_terlambat', header: 'Telat (menit)', width: 14 },
  { key: 'jam_kerja', header: 'Jam Kerja', width: 12 },
  { key: 'jam_lembur', header: 'Lembur (jam)', width: 13 },
  { key: 'status_label', header: 'Status', width: 16 },
  { key: 'scan_count', header: 'Jumlah Scan', width: 12 },
  { key: 'note', header: 'Keterangan', width: 30 },
];

const MONTHLY_COLUMNS = [
  { key: 'employee_code', header: 'Kode Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Departemen', width: 20 },
  { key: 'position_name', header: 'Jabatan', width: 18 },
  { key: 'total_days', header: 'Total Hari', width: 12 },
  { key: 'total_hadir', header: 'Hadir', width: 9 },
  { key: 'total_telat', header: 'Telat', width: 9 },
  { key: 'total_izin', header: 'Izin', width: 9 },
  { key: 'total_sakit', header: 'Sakit', width: 9 },
  { key: 'total_cuti', header: 'Cuti', width: 9 },
  { key: 'total_dinas_luar', header: 'Dinas Luar', width: 13 },
  { key: 'total_dinas_dalam', header: 'Dinas Dalam', width: 13 },
  { key: 'total_alpa', header: 'Alpa', width: 9 },
  { key: 'persen_hadir', header: '% Kehadiran', width: 13 },
  { key: 'total_late_minutes', header: 'Total Telat (menit)', width: 18 },
  { key: 'rata_late_jam', header: 'Rata-rata Telat (jam)', width: 19 },
  { key: 'max_late_minutes', header: 'Telat Terlama (menit)', width: 20 },
  { key: 'total_kerja_jam', header: 'Total Kerja (jam)', width: 17 },
  { key: 'total_lembur_jam', header: 'Total Lembur (jam)', width: 18 },
];

const RAW_COLUMNS = [
  { key: 'log_time_text', header: 'Waktu', width: 20 },
  { key: 'jam', header: 'Jam', width: 9 },
  { key: 'employee_code', header: 'Kode Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'device_user_id', header: 'PIN Mesin', width: 12 },
  { key: 'metode', header: 'Metode', width: 14 },
  { key: 'state_label', header: 'Jenis', width: 14 },
  { key: 'work_code', header: 'Kode Kerja', width: 12 },
  { key: 'device_name', header: 'Perangkat', width: 20 },
  { key: 'source', header: 'Sumber', width: 10 },
];

const SUMMARY_COLUMNS = [
  { key: 'work_date', header: 'Tanggal', width: 14 },
  { key: 'hadir', header: 'Hadir', width: 9 },
  { key: 'telat', header: 'Telat', width: 9 },
  { key: 'izin', header: 'Izin', width: 9 },
  { key: 'sakit', header: 'Sakit', width: 9 },
  { key: 'cuti', header: 'Cuti', width: 9 },
  { key: 'dinas_luar', header: 'Dinas Luar', width: 13 },
  { key: 'dinas_dalam', header: 'Dinas Dalam', width: 13 },
  { key: 'alpa', header: 'Alpa', width: 9 },
  { key: 'belum', header: 'Belum', width: 9 },
  { key: 'hari_libur', header: 'Libur', width: 9 },
  { key: 'total', header: 'Total', width: 10 },
];

const EMPLOYEE_COLUMNS = [
  { key: 'employee_code', header: 'Kode Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Departemen', width: 20 },
  { key: 'hari_kerja', header: 'Hari Kerja', width: 12 },
  { key: 'hadir', header: 'Hadir', width: 9 },
  { key: 'telat', header: 'Telat', width: 9 },
  { key: 'izin', header: 'Izin', width: 9 },
  { key: 'sakit', header: 'Sakit', width: 9 },
  { key: 'dinas_luar', header: 'Dinas Luar', width: 12 },
  { key: 'dinas_dalam', header: 'Dinas Dalam', width: 12 },
  { key: 'alpa', header: 'Alpa', width: 9 },
  { key: 'persen_hadir', header: '% Kehadiran', width: 13 },
  { key: 'total_late_minutes', header: 'Total Telat (menit)', width: 18 },
  { key: 'total_work_minutes', header: 'Total Kerja (menit)', width: 18 },
];

const OVERTIME_COLUMNS = [
  { key: 'employee_code', header: 'Kode Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Departemen', width: 20 },
  { key: 'position_name', header: 'Jabatan', width: 18 },
  { key: 'days_with_overtime', header: 'Hari Lembur', width: 12 },
  { key: 'total_overtime_minutes', header: 'Total Lembur (menit)', width: 18 },
  { key: 'total_overtime_jam', header: 'Total Lembur (jam)', width: 16 },
  { key: 'max_overtime_minutes', header: 'Lembur Terlama (menit)', width: 20 },
  { key: 'max_overtime_jam', header: 'Lembur Terlama (jam)', width: 18 },
];

const ATTENDANCE_RECAP_COLUMNS = [
  { key: 'no_urut', header: 'No', width: 6 },
  { key: 'employee_code', header: 'ID Karyawan', width: 16 },
  { key: 'employee_name', header: 'Nama', width: 26 },
  { key: 'department_name', header: 'Divisi/Departemen', width: 20 },
  { key: 'position_name', header: 'Jabatan', width: 18 },
  { key: 'total_hari_kerja', header: 'Total Hari Kerja', width: 14 },
  { key: 'total_hadir', header: 'Total Kehadiran', width: 14 },
  { key: 'total_izin', header: 'Total Izin', width: 10 },
  { key: 'total_cuti', header: 'Total Cuti', width: 10 },
  { key: 'total_dinas_luar', header: 'Total Dinas Luar', width: 14 },
  { key: 'total_dinas_dalam', header: 'Total Dinas Dalam', width: 14 },
  { key: 'total_hari_terlambat', header: 'Total Hari Terlambat', width: 16 },
  { key: 'total_lembur_jam', header: 'Total Lemburan (jam)', width: 16 },
];

// ---------------------------------------------------------------------------
// Ekspor Excel
// ---------------------------------------------------------------------------

/**
 * Buat workbook Excel dari hasil build().
 * Mengembalikan Buffer siap kirim sebagai attachment.
 */
async function exportExcel(format, options = {}) {
  const report = await build(format, options);
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Aplikasi Absensi Fingerprint';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetNameFor(format, report.range), {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  // Judul
  sheet.mergeCells(1, 1, 1, Math.max(1, report.columns.length));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = titleFor(format, report.range);
  titleCell.font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  titleCell.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 24;

  // Sub-judul periode
  sheet.mergeCells(2, 1, 2, Math.max(1, report.columns.length));
  const subCell = sheet.getCell(2, 1);
  subCell.value = `Dicetak: ${new Date().toLocaleString('id-ID')}   |   Zona waktu: ${process.env.TZ || '-'}`;
  subCell.font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  // Header tabel (baris 4)
  const headerRow = sheet.getRow(4);
  report.columns.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
    sheet.getColumn(index + 1).width = col.width || 15;
  });
  headerRow.height = 28;

  // Isi data
  report.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(5 + rowIndex);
    report.columns.forEach((col, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      cell.value = row[col.key] ?? '';
      cell.border = thinBorder();
      if (rowIndex % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } };
      }
    });
  });

  // Filter otomatis + total di bawah
  if (report.columns.length > 0) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4 + report.rows.length, column: report.columns.length },
    };
  }

  if (format === 'ringkasan' && report.summary) {
    addSummaryBlock(workbook, report.summary, report.range);
  }

  return {
    buffer: await workbook.xlsx.writeBuffer(),
    filename: buildFilename(format, report.range),
    meta: report.meta,
  };
}

function thinBorder() {
  const side = { style: 'thin', color: { argb: 'FFD0D7DE' } };
  return { top: side, left: side, bottom: side, right: side };
}

function addSummaryBlock(workbook, summary, range) {
  const sheet = workbook.addWorksheet('Ringkasan');
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 18;

  sheet.getCell('A1').value = 'RINGKASAN ABSENSI';
  sheet.getCell('A1').font = { bold: true, size: 13 };

  const rows = [
    ['Periode', `${range.from} s/d ${range.to}`],
    ['Jumlah karyawan', summary.totals.employees],
    ['Total hadir', summary.by_status.hadir || 0],
    ['Total telat', summary.by_status.telat || 0],
    ['Total izin', summary.by_status.izin || 0],
    ['Total sakit', summary.by_status.sakit || 0],
    ['Total cuti', summary.by_status.cuti || 0],
  ['Total dinas luar kota', summary.by_status.dinas_luar || 0],
  ['Total dinas dalam kota', summary.by_status.dinas_dalam || 0],
  ['Total alpa', summary.by_status.alpa || 0],
    ['Total belum absen', summary.by_status.belum || 0],
    ['Total keterlambatan (menit)', summary.totals.total_late_minutes],
    ['Rata-rata keterlambatan (menit)', summary.totals.avg_late_minutes],
    ['Total jam kerja (jam)', (summary.totals.total_work_minutes / 60).toFixed(2)],
    ['Total lembur (jam)', (summary.totals.total_overtime_minutes / 60).toFixed(2)],
  ];

  rows.forEach(([label, value], index) => {
    const row = sheet.getRow(3 + index);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: index === 0 };
    row.getCell(2).value = value;
  });
}

function titleFor(format, range) {
  const map = {
    rekap_harian: 'LAPORAN REKAP ABSENSI HARIAN',
    rekap_bulanan: 'LAPORAN REKAP ABSENSI BULANAN',
    log_mentah: 'LAPORAN LOG ABSENSI MENTAH',
    ringkasan: 'LAPORAN RINGKASAN ABSENSI HARIAN',
    per_karyawan: 'LAPORAN REKAP PER KARYAWAN',
    lembur: 'LAPORAN LEMBUR PER KARYAWAN',
    rekap_kehadiran: 'REKAP KEHADIRAN KARYAWAN',
  };
  const period = range.month
    ? `${monthName(Number(range.month.slice(5, 7)))} ${range.month.slice(0, 4)}`
    : `${range.from} s/d ${range.to}`;
  return `${map[format] || 'LAPORAN ABSENSI'} - ${period}`;
}

function sheetNameFor(format, range) {
  const map = {
    rekap_harian: 'Rekap Harian',
    rekap_bulanan: 'Rekap Bulanan',
    log_mentah: 'Log Mentah',
    ringkasan: 'Ringkasan',
    per_karyawan: 'Per Karyawan',
    lembur: 'Lembur',
    rekap_kehadiran: 'Rekap Kehadiran',
  };
  void range;
  return map[format] || 'Laporan';
}

function buildFilename(format, range) {
  const stamp = range.month || range.from;
  const names = {
    rekap_harian: 'rekap-harian',
    rekap_bulanan: 'rekap-bulanan',
    log_mentah: 'log-mentah',
    ringkasan: 'ringkasan',
    per_karyawan: 'per-karyawan',
    lembur: 'lembur',
    rekap_kehadiran: 'rekap-kehadiran',
  };
  return `absensi-${names[format] || format}-${stamp}.xlsx`;
}

/** Ekspor CSV sederhana (tanpa styling) untuk integrasi lain. */
async function exportCsv(format, options = {}) {
  const report = await build(format, options);
  const headers = report.columns.map((c) => c.header);
  const lines = [headers.map(escapeCsv).join(',')];

  for (const row of report.rows) {
    lines.push(report.columns.map((c) => escapeCsv(row[c.key] ?? '')).join(','));
  }

  return {
    buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'),
    filename: buildFilename(format, report.range).replace(/\.xlsx$/, '.csv'),
    meta: report.meta,
  };
}

function escapeCsv(value) {
  const str = String(value ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

module.exports = {
  FORMAT_LIST,
  FORMATS,
  build,
  exportExcel,
  exportCsv,
  buildDailyRows,
  buildMonthlyRows,
};
