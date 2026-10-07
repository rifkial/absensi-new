'use strict';

/**
 * Seeder data dummy kehadiran karyawan, 1 s/d 7 Oktober 2026.
 *
 * Berbeda dengan tools/seed-dummy.js (yang mengosongkan SELURUH data absensi dan
 * memaksa semua karyawan memakai jadwal global), seeder ini:
 *  - hanya menyentuh data pada periode 1 s/d 7 Oktober 2026;
 *  - tidak mengubah shift default karyawan, sehingga rekap memakai shift asli
 *    (termasuk jadwal per tanggal di tabel schedules);
 *  - aman dijalankan berulang kali karena baris lama di periode yang sama
 *    dibersihkan lebih dulu sebelum diisi ulang.
 *
 * Yang dibuat:
 *  - leave_requests   : izin / sakit / cuti / dinas yang disetujui supaya laporan
 *                       punya semua status, plus 1 pengajuan menunggu persetujuan.
 *  - attendance_logs  : scan mentah (masuk / istirahat / keluar) mengikuti jam
 *                       shift masing-masing karyawan, dengan variasi tepat waktu,
 *                       telat masuk, lembur, dan tidak absen.
 *  - attendance_daily : rekap harian dihitung ulang oleh services/attendance.
 *
 * Jalankan: node tools/seed-oktober.js
 */

const db = require('../src/db/pool');
const attendance = require('../src/services/attendance');
const shiftsService = require('../src/services/shifts');
const leaveCatalog = require('../src/services/leaveCatalog');
const { dayjs, addDays, dateRange, timeToMinutes } = require('../src/utils/date');

const FROM = '2026-10-01';
const TO = '2026-10-07';
const DATE = 'YYYY-MM-DD';

// Pola absensi per karyawan, dikunci ke employee_code supaya hasilnya tetap sama
// walau urutan baris di database berubah. Sisa dari 1 = datang tepat waktu.
const PROFILES = {
  '001': { lateIn: 0.30, lateOut: 0.15, absent: 0.05 },
  '002': { lateIn: 0.10, lateOut: 0.25, absent: 0.00 },
  '003': { lateIn: 0.25, lateOut: 0.10, absent: 0.15 },
  '004': { lateIn: 0.15, lateOut: 0.35, absent: 0.00 },
  '005': { lateIn: 0.20, lateOut: 0.20, absent: 0.10 },
};

const DEFAULT_PROFILE = { lateIn: 0.2, lateOut: 0.2, absent: 0.05 };

/**
 * Pengajuan yang menutupi periode ini. Tanggal yang tercantum di sini tidak
 * diberi scan, supaya rekap menghasilkan status izin/sakit/cuti/dinas, bukan
 * hadir.
 */
const LEAVES = [
  {
    employee: '002', subtype: 'izin_sakit', start: '2026-10-01', end: '2026-10-02',
    reason: 'Demam dan flu', approved: true,
  },
  {
    employee: '004', subtype: 'dinas_luar_kota', start: '2026-10-05', end: '2026-10-06',
    place: 'Bandung, Jawa Barat', reason: 'Pelatihan regional', approved: true,
  },
  {
    employee: '005', subtype: 'cuti_tahunan', start: '2026-10-06', end: '2026-10-07',
    reason: 'Cuti tahunan', approved: true,
  },
  {
    employee: '003', subtype: 'dinas_dalam_kota', start: '2026-10-07', end: '2026-10-07',
    place: 'Kantor Pusat', reason: 'Rapat koordinasi dengan unit bisnis', approved: true,
  },
  {
    employee: '002', subtype: 'izin_keluarga', start: '2026-10-07', end: '2026-10-07',
    reason: 'Mengurus keluarga', approved: false,
  },
];

/** PRNG sederhana (LCG) supaya hasil seeder selalu sama tiap kali dijalankan. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function random() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function seedFrom(code) {
  let h = 0;
  for (let i = 0; i < code.length; i += 1) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Tanggal + menit-sesudah-tengah-malam -> waktu log absolut.
 * Nilai > 1440 otomatis bergeser ke tanggal berikutnya, sehingga shift malam
 * (23:00-07:00) cukup ditulis sebagai 1380 (masuk) dan 1860 (pulang).
 */
function atMinutes(dateStr, minutes) {
  const dayOffset = Math.floor(minutes / 1440);
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const d = dayjs(dateStr).add(dayOffset, 'day').add(total, 'minute');
  const logDate = d.format(DATE);
  return { logDate, logTime: `${logDate} ${d.format('HH:mm:ss')}` };
}

/**
 * Susun daftar scan untuk satu karyawan pada satu hari kerja.
 * Mengembalikan array { logDate, logTime, state, verify }.
 */
function buildScans(shift, workDate, profile, roll, random) {
  if (roll < profile.absent) return [];

  const start = timeToMinutes(shift.start_time, 0);
  const endRaw = timeToMinutes(shift.end_time, 0);
  const overnight = shiftsService.isOvernight(shift);
  const end = overnight ? endRaw + 1440 : endRaw;
  const tolerance = shiftsService.toleranceOf(shift);

  const isLateIn = roll < profile.absent + profile.lateIn;
  const isLateOut =
    roll >= profile.absent + profile.lateIn &&
    roll < profile.absent + profile.lateIn + profile.lateOut;

  const firstIn = isLateIn
    ? start + tolerance + 5 + Math.floor(random() * 70) // lewat toleransi => telat
    : start - 25 + Math.floor(random() * 20);          // datang 5-25 menit lebih awal
  const firstOut = isLateOut
    ? end + 20 + Math.floor(random() * 130) // lembur 20-150 menit
    : end - 15 + Math.floor(random() * 20); // pulang 5-15 menit lebih cepat

  const scans = [{ ...atMinutes(workDate, firstIn), state: 0, verify: 15 }]; // check in

  const brkStart = timeToMinutes(shift.break_start, null);
  const brkEnd = timeToMinutes(shift.break_end, null);
  if (brkStart !== null && brkEnd !== null) {
    // Istirahat shift MALAM (03:00-03:30) jatuh di tanggal berikutnya, jadi
    // digeser +1440. Shift pagi/siang tetap di tanggal yang sama.
    const brkBase = overnight ? 1440 : 0;
    scans.push({ ...atMinutes(workDate, brkStart + brkBase), state: 2, verify: 15 });
    scans.push({ ...atMinutes(workDate, brkEnd + brkBase), state: 3, verify: 15 });
  }

  scans.push({ ...atMinutes(workDate, firstOut), state: 1, verify: 15 }); // check out
  return scans.sort((a, b) => (a.logTime < b.logTime ? -1 : 1));
}

/** Catatan yang menandai jadwal libur buatan seeder ini. */
const REST_NOTE = 'Libur setelah shift malam (dummy)';

/**
 * Tandai satu tanggal sebagai hari libur untuk seorang karyawan.
 * Memakai catatan khusus supaya clearRange bisa menghapus ulang barisnya
 * tanpa menyentuh jadwal asli milik admin.
 */
async function markRestDay(employeeId, workDate) {
  await db.execute(
    `INSERT INTO schedules (employee_id, work_date, shift_id, day_type, note)
     VALUES (?, ?, NULL, 'libur', ?)
     ON DUPLICATE KEY UPDATE day_type = 'libur', note = VALUES(note)`,
    [employeeId, workDate, REST_NOTE]
  );
}

/** Hapus baris seeder pada periode ini supaya bisa dijalankan ulang. */
async function clearRange() {
  // Pulang shift malam jatuh di tanggal setelah TO, jadi ikut dibersihkan.
  const cleanupTo = addDays(TO, 1);
  const logs = await db.queryScalar(
    'SELECT COUNT(*) AS total FROM attendance_logs WHERE log_date BETWEEN ? AND ?',
    [FROM, cleanupTo]
  );
  const daily = await db.queryScalar(
    'SELECT COUNT(*) AS total FROM attendance_daily WHERE work_date BETWEEN ? AND ?',
    [FROM, TO]
  );
  const rests = await db.queryScalar(
    'SELECT COUNT(*) AS total FROM schedules WHERE work_date BETWEEN ? AND ? AND note = ?',
    [FROM, TO, REST_NOTE]
  );
  await db.execute('DELETE FROM attendance_logs WHERE log_date BETWEEN ? AND ?', [FROM, cleanupTo]);
  await db.execute('DELETE FROM attendance_daily WHERE work_date BETWEEN ? AND ?', [FROM, TO]);
  await db.execute('DELETE FROM schedules WHERE work_date BETWEEN ? AND ? AND note = ?', [FROM, TO, REST_NOTE]);
  console.log(
    `[seed] Bersih: ${logs} log, ${daily} rekap, ${rests} jadwal libur shift malam ` +
    `pada ${FROM} s/d ${TO} (log s.d. ${cleanupTo}).`
  );
}

async function insertLeaves(employees) {
  const admin = await db.queryOne(
    `SELECT id FROM app_users WHERE role = 'admin' ORDER BY id LIMIT 1`
  );
  const reviewerId = admin ? admin.id : null;
  let inserted = 0;

  for (const l of LEAVES) {
    const sub = leaveCatalog.findSubtype(l.subtype);
    if (!sub) throw new Error(`Sub-jenis pengajuan tidak dikenal: ${l.subtype}`);
    const employee = employees.find((e) => e.employee_code === l.employee);
    if (!employee) throw new Error(`Karyawan dengan NIK ${l.employee} tidak ada.`);

    // Idempoten per (karyawan, tanggal mulai, sub-jenis).
    await db.execute(
      'DELETE FROM leave_requests WHERE employee_id = ? AND start_date = ? AND subtype = ?',
      [employee.id, l.start, sub.key]
    );

    await db.execute(
      `INSERT INTO leave_requests
         (employee_id, leave_type, subtype, place, start_date, end_date, reason,
          status, reviewed_by, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employee.id,
        sub.leave_type,
        sub.key,
        l.place || null,
        l.start,
        l.end,
        l.reason,
        l.approved ? 'approved' : 'pending',
        l.approved ? reviewerId : null,
        l.approved ? `${l.start} 08:30:00` : null,
        `${addDays(l.start, -2)} 09:00:00`,
      ]
    );
    inserted += 1;
  }

  const approved = LEAVES.filter((l) => l.approved).length;
  console.log(
    `[seed] ${inserted} pengajuan (${approved} disetujui, ${inserted - approved} menunggu persetujuan).`
  );
}

/** Kumpulan tanggal yang sudah tertutup pengajuan, dikelompokkan per karyawan. */
function leaveDatesByEmployee(employees) {
  const map = new Map();
  for (const l of LEAVES) {
    if (!l.approved) continue;
    const employee = employees.find((e) => e.employee_code === l.employee);
    if (!employee) continue;
    const set = map.get(employee.id) || new Set();
    for (const date of dateRange(l.start, l.end)) set.add(date);
    map.set(employee.id, set);
  }
  return map;
}

async function insertLogs(employees) {
  const dates = dateRange(FROM, TO);
  const now = dayjs();
  const leaveDates = leaveDatesByEmployee(employees);
  const rows = [];
  const stats = {
    total: 0, lateIn: 0, lateOut: 0, absent: 0, offDay: 0, onLeave: 0, restDay: 0, future: 0,
  };

  for (const employee of employees) {
    const random = makeRandom(seedFrom(employee.employee_code));
    const profile = PROFILES[employee.employee_code] || DEFAULT_PROFILE;
    const offDates = leaveDates.get(employee.id) || new Set();
    let afterNightShift = false;

    for (const workDate of dates) {
      if (offDates.has(workDate)) {
        stats.onLeave += 1;
        afterNightShift = false;
        continue;
      }

      const { shift, dayType } = await attendance.resolveShift(employee.id, workDate);
      if (!shift || dayType === 'libur' || !shiftsService.isWorkingDay(shift, workDate)) {
        stats.offDay += 1;
        afterNightShift = false;
        continue;
      }

      const overnight = shiftsService.isOvernight(shift);

      // services/attendance.getLogsFor menarik log "pulang" ke tanggal
      // berikutnya, sehingga dua shift malam berurutan tidak bisa dipisahkan:
      // sisa log shift malam sebelumnya ikut terambil dan merusak first_in
      // rekap hari ini. Untuk dummy data, hari setelah shift malam
      // dijadwalkan libur.
      if (overnight && afterNightShift) {
        await markRestDay(employee.id, workDate);
        stats.restDay += 1;
        afterNightShift = false;
        continue;
      }

      const scans = buildScans(shift, workDate, profile, random(), random);
      if (scans.length === 0) {
        stats.absent += 1;
        afterNightShift = overnight;
        continue;
      }

      afterNightShift = overnight;

      const startMin = timeToMinutes(shift.start_time, 0);
      const tolerance = shiftsService.toleranceOf(shift);
      const inMin = timeToMinutes(scans[0].logTime.slice(11, 16), 0);
      if (inMin > startMin + tolerance) stats.lateIn += 1;

      const outMin = timeToMinutes(scans[scans.length - 1].logTime.slice(11, 16), 0);
      const endMin = timeToMinutes(shift.end_time, 0);
      if (outMin > endMin || outMin < endMin - 60) stats.lateOut += 1;

      for (const scan of scans) {
        // Jangan tulis log di masa depan, mis. pulang shift malam yang belum
        // terjadi karena hari ini belum lewat tengah malam.
        if (dayjs(scan.logTime).isAfter(now)) {
          stats.future += 1;
          continue;
        }
        rows.push([
          null,
          employee.id,
          employee.device_user_id,
          scan.logTime,
          scan.logDate,
          scan.state,
          scan.verify,
          '1',
          'manual',
        ]);
        stats.total += 1;
      }
    }
  }

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const sql =
      'INSERT INTO attendance_logs ' +
      '(device_id, employee_id, device_user_id, log_time, log_date, log_state, verify_mode, work_code, source) VALUES ' +
      slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(', ');
    await db.executeLarge(sql, slice.flat());
  }

  console.log(
    `[seed] ${rows.length} scan untuk ${employees.length} karyawan x ${dates.length} tanggal: ` +
    `telat masuk ${stats.lateIn}, lembur/pulang cepat ${stats.lateOut}, ` +
    `alpa ${stats.absent}, di luar hari kerja ${stats.offDay}, libur setelah shift malam ${stats.restDay}, ` +
    `pengajuan ${stats.onLeave}, dilewati (masa depan) ${stats.future}.`
  );
}

(async () => {
  console.log('===============================================');
  console.log(' SEED DATA DUMMY KEHADIRAN - OKTOBER 2026');
  console.log(` Periode: ${FROM} s/d ${TO}`);
  console.log('===============================================');

  const employees = await db.queryAll(
    `SELECT id, employee_code, device_user_id, name, shift_id, hire_date
       FROM employees
      WHERE status <> 'resign'
      ORDER BY id ASC`
  );
  if (employees.length === 0) throw new Error('Tidak ada karyawan. Jalankan npm run seed dulu.');
  console.log(`[seed] ${employees.length} karyawan: ${employees.map((e) => e.employee_code).join(', ')}`);

  await clearRange();
  await insertLeaves(employees);
  await insertLogs(employees);

  const result = await attendance.generate({ from: FROM, to: TO });
  console.log('[seed] Rekap harian:', result.message);

  const summary = await attendance.summary({ from: FROM, to: TO });
  console.log('[seed] Total:', JSON.stringify(summary.totals));
  console.log('[seed] Per status:', JSON.stringify(summary.by_status));
  console.table(summary.per_day);
  console.log('[seed] Selesai.');

  await db.closePool();
})().catch(async (err) => {
  console.error('[seed] GAGAL:', err.message);
  try { await db.closePool(); } catch { /* ignore */ }
  process.exit(1);
});
