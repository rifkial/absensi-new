'use strict';

/**
 * Seeder data dummy untuk pengujian laporan.
 *
 * Mengganti seluruh data absensi yang ada dengan data baru:
 *  - semua karyawan memakai JADWAL GLOBAL (employees.shift_id = NULL),
 *    sehingga patokan jam kerja diambil dari Pengaturan, bukan tabel shifts;
 *  - scan_raw (attendance_logs) dibuat untuk 1 s/d 30 September 2026 pada
 *    hari kerja Senin-Jumat, lengkap dengan variasi:
 *      * masuk tepat waktu / sebelum jam kerja
 *      * cek in TELAT ( lewat toleransi )
 *      * cek out TELAT ( lembur )
 *      * tidak ada scan sama sekali ( belum )
 *      * izin / sakit / cuti lewat leave_requests yang sudah disetujui
 *
 * Jalankan:  node tools/seed-dummy.js
 * Data lama dihapus permanen, jadi jalankan hanya pada database uji.
 */

const fs = require('fs');
const path = require('path');

const db = require('../src/db/pool');
const attendance = require('../src/services/attendance');
const leaveCatalog = require('../src/services/leaveCatalog');

const FROM = '2026-09-01';
const TO = '2026-09-30';

// Jadwal global yang dipakai seeder ini (disimpan juga ke tabel settings).
const GLOBAL = {
  use_global_when_no_shift: 'true',
  global_check_in: '08:00',
  global_check_out: '17:00',
  global_late_tolerance: '10',
  global_break_start: '12:00',
  global_break_end: '13:00',
};

// Pola absensi tiap karyawan (persentase, sisanya = tepat waktu).
const PROFILES = [
  { id: 1, code: '001', name: 'Ahmad Fauzi', dept: 1, pos: 3, lateIn: 0.20, lateOut: 0.15, absent: 0.02 },
  { id: 2, code: '002', name: 'Siti Aminah', dept: 1, pos: 3, lateIn: 0.10, lateOut: 0.25, absent: 0.02 },
  { id: 3, code: '003', name: 'Budi Santoso', dept: 2, pos: 2, lateIn: 0.30, lateOut: 0.10, absent: 0.05 },
  { id: 4, code: '004', name: 'Dewi Lestari', dept: 2, pos: 4, lateIn: 0.15, lateOut: 0.35, absent: 0.03 },
  { id: 5, code: '005', name: 'Eko Prasetyo', dept: 3, pos: 3, lateIn: 0.25, lateOut: 0.20, absent: 0.04 },
];

// Pengajuan cuti/izin/dinas memakai sub-jenis katalog (leaveCatalog) supaya
// label/status di halaman pengajuan dan rekap harian sama dengan data asli.
// pending = true -> pengajuan menunggu persetujuan di halaman admin.
const LEAVES = [
  { employee: 1, subtype: 'izin_kebutuhan_pribadi', start: '2026-09-03', end: '2026-09-03', reason: 'Keperluan pribadi', approved: true },
  { employee: 2, subtype: 'izin_tidak_masuk', start: '2026-09-10', end: '2026-09-11', reason: 'Sakit (demam dan flu), diinput sebagai izin', approved: true },
  { employee: 3, subtype: 'cuti_tahunan', start: '2026-09-17', end: '2026-09-18', reason: 'Cuti tahunan', approved: true },
  { employee: 4, subtype: 'dinas_luar_kota', start: '2026-09-24', end: '2026-09-25', place: 'Bandung, Jawa Barat', reason: 'Pelatihan regional', approved: true },
  { employee: 5, subtype: 'izin_keluarga', start: '2026-09-29', end: '2026-09-29', reason: 'Mengurus keluarga', approved: true },
  { employee: 1, subtype: 'izin_administrasi', start: '2026-09-28', end: '2026-09-28', reason: 'Mengurus dokumen', approved: false },
  { employee: 3, subtype: 'dinas_dalam_kota', start: '2026-09-30', end: '2026-09-30', place: 'Kantor Pusat', reason: 'Rapat koordinasi', approved: false },
];

// Reimburse: mengikuti field reimburses (employee_id, description, amount,
// status, reviewed_by, reviewed_at).
const REIMBURSES = [
  { employee: 1, description: 'Transport dinas ke kantor cabang', amount: 175000, status: 'approved', reviewed_at: '2026-09-12 10:15:00' },
  { employee: 2, description: 'Biaya makan rapat tim', amount: 320000, status: 'approved', reviewed_at: '2026-09-19 14:05:00' },
  { employee: 3, description: 'Penginapan dinas luar kota', amount: 850000, status: 'pending', reviewed_at: null },
  { employee: 4, description: 'BBM mobil dinas', amount: 240000, status: 'rejected', reviewed_at: '2026-09-20 09:30:00' },
  { employee: 5, description: 'Alat tulis kantor', amount: 95000, status: 'pending', reviewed_at: null },
];

/** PRNG sederhana supaya hasilnya selalu sama tiap kali dijalankan. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function random() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateAt(dateStr, minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${dateStr} ${pad(h)}:${pad(m)}:00`;
}

function dayOfWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay(); // 0=Minggu .. 6=Sabtu
}

function listWorkDates(from, to) {
  const out = [];
  const cursor = new Date(`${from}T00:00:00`);
  const last = new Date(`${to}T00:00:00`);
  while (cursor <= last) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      out.push(
        cursor.getFullYear() + '-' + pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate())
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function listWeekendDates(from, to) {
  const out = [];
  const cursor = new Date(`${from}T00:00:00`);
  const last = new Date(`${to}T00:00:00`);
  while (cursor <= last) {
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) {
      out.push(
        cursor.getFullYear() + '-' + pad(cursor.getMonth() + 1) + '-' + pad(cursor.getDate())
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

const inMin = (h, m) => h * 60 + m;
const GLOBAL_IN = inMin(8, 0);
const GLOBAL_OUT = inMin(17, 0);

/** Susun daftar scan mentah untuk satu karyawan pada satu tanggal. */
function buildScans(profile, dateStr, roll, random) {
  if (roll < profile.absent) return []; // tidak absen sama sekali

  const isLateIn = roll >= profile.absent && roll < profile.absent + profile.lateIn;
  const isLateOut =
    roll >= profile.absent + profile.lateIn &&
    roll < profile.absent + profile.lateIn + profile.lateOut;

  const firstIn = isLateIn
    ? inMin(8, 12) + Math.floor(random() * 90) // 08:12 - 09:41
    : inMin(7, 35) + Math.floor(random() * 25); // 07:35 - 07:59
  const firstOut = isLateOut
    ? inMin(17, 40) + Math.floor(random() * 165) // 17:40 - 20:24
    : inMin(16, 45) + Math.floor(random() * 25); // 16:45 - 17:09

  const scans = [
    { time: dateAt(dateStr, firstIn), state: 0, verify: 15 },
    { time: dateAt(dateStr, inMin(12, 0) + Math.floor(random() * 5)), state: 2, verify: 15 },
    { time: dateAt(dateStr, inMin(13, 0) + Math.floor(random() * 5)), state: 3, verify: 15 },
    { time: dateAt(dateStr, firstOut), state: 1, verify: 15 },
  ];
  return scans.sort((a, b) => (a.time < b.time ? -1 : 1));
}

async function backup() {
  const dir = path.join(process.env.TEMP || '.', 'absensi-backup');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dummy-sebelum-${Date.now()}.sql`);
  const tables = ['attendance_daily', 'attendance_logs', 'duty_checkins', 'leave_requests', 'schedules', 'reimburses'];

  const lines = [`-- Backup data absensi sebelum seeder dummy (${new Date().toISOString()})`];
  for (const table of tables) {
    const rows = await db.queryAll(`SELECT * FROM \`${table}\``);
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    lines.push(`-- ${table} (${rows.length} baris)`);
    for (const row of rows) {
      const values = cols
        .map((c) => {
          const v = row[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        })
        .join(', ');
      lines.push(`INSERT INTO \`${table}\` (${cols.join(', ')}) VALUES (${values});`);
    }
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`[seed] Backup data lama: ${file}`);
}

async function clear() {
  const tables = ['attendance_daily', 'attendance_logs', 'duty_checkins', 'leave_requests', 'schedules', 'reimburses'];
  for (const table of tables) {
    const [{ total }] = await db.queryAll(`SELECT COUNT(*) AS total FROM \`${table}\``);
    await db.execute(`DELETE FROM \`${table}\``);
    await db.execute(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);
    console.log(`[seed] ${table}: ${total} baris dihapus`);
  }
}

async function applySettings() {
  for (const [key, value] of Object.entries(GLOBAL)) {
    await db.execute(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value]
    );
  }
  console.log('[seed] Jadwal global diaktifkan:', GLOBAL.global_check_in, '-', GLOBAL.global_check_out);
}

async function applyEmployees() {
  for (const p of PROFILES) {
    await db.execute(
      `UPDATE employees
          SET employee_code = ?, device_user_id = ?, name = ?,
              department_id = ?, position_id = ?, shift_id = NULL, status = 'aktif'
        WHERE id = ?`,
      [p.code, String(p.id), p.name, p.dept, p.pos, p.id]
    );
  }
  attendance.invalidateGlobalShift();
  console.log(`[seed] ${PROFILES.length} karyawan disetel tanpa shift (pakai jadwal global)`);
}

async function insertLogs() {
  const dates = listWorkDates(FROM, TO);
  const rows = [];
  const stats = { total: 0, lateIn: 0, lateOut: 0, absent: 0 };

  for (const p of PROFILES) {
    const random = makeRandom(p.id * 7919);
    for (const dateStr of dates) {
      const roll = random();
      const scans = buildScans(p, dateStr, roll, random);

      if (scans.length === 0) {
        stats.absent += 1;
        continue;
      }
      const tolerance = inMin(0, Number(GLOBAL.global_late_tolerance));
      const firstInMin = Number(scans[0].time.slice(11, 13)) * 60 + Number(scans[0].time.slice(14, 16));
      const lastOutMin = Number(scans[scans.length - 1].time.slice(11, 13)) * 60 + Number(scans[scans.length - 1].time.slice(14, 16));
      if (firstInMin > GLOBAL_IN + tolerance) stats.lateIn += 1;
      if (lastOutMin > GLOBAL_OUT) stats.lateOut += 1;

      for (const scan of scans) {
        rows.push([null, p.id, String(p.id), scan.time, dateStr, scan.state, scan.verify, '1', 'manual']);
        stats.total += 1;
      }
    }
  }

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const sql =
      `INSERT INTO attendance_logs
         (device_id, employee_id, device_user_id, log_time, log_date, log_state, verify_mode, work_code, source)
       VALUES ` +
      slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(', ');
    await db.executeLarge(sql, slice.flat());
  }

  console.log(
    `[seed] ${rows.length} scan mentah (${dates.length} hari kerja x ${PROFILES.length} karyawan): ` +
    `telat masuk ${stats.lateIn} hari, telat keluar ${stats.lateOut} hari, tidak absen ${stats.absent} hari`
  );
}

/**
 * Jadwal global selalu considers 7 hari sebagai hari kerja, jadi akhir pekan
 * ditandai lewat tabel schedules (day_type = 'libur') supaya rekap menghasilkan
 * status hari_libur, bukan alpa.
 */
async function insertWeekendSchedules() {
  const dates = listWeekendDates(FROM, TO);
  let written = 0;
  for (const p of PROFILES) {
    for (const dateStr of dates) {
      await db.execute(
        `INSERT INTO schedules (employee_id, work_date, shift_id, day_type, note)
         VALUES (?, ?, NULL, 'libur', 'Akhir pekan')
         ON DUPLICATE KEY UPDATE day_type = VALUES(day_type), note = VALUES(note)`,
        [p.id, dateStr]
      );
      written += 1;
    }
  }
  console.log(`[seed] ${written} jadwal akhir pekan (day_type=libur) untuk ${dates.length} tanggal`);
}

async function insertLeaves() {
  const admin = await db.queryOne(`SELECT id FROM app_users WHERE username = 'admin' LIMIT 1`);
  const reviewerId = admin ? admin.id : null;

  for (const l of LEAVES) {
    const sub = leaveCatalog.findSubtype(l.subtype);
    if (!sub) throw new Error(`Sub-jenis pengajuan tidak dikenal: ${l.subtype}`);

    const status = l.approved ? 'approved' : 'pending';
    const reviewedAt = l.approved ? `'${l.start} 09:00:00'` : 'NULL';

    await db.execute(
      `INSERT INTO leave_requests
         (employee_id, leave_type, subtype, place, start_date, end_date, reason,
          status, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${reviewedAt})`,
      [
        l.employee,
        sub.leave_type,
        sub.key,
        l.place || null,
        l.start,
        l.end,
        l.reason,
        status,
        l.approved ? reviewerId : null,
      ]
    );
  }
  const approved = LEAVES.filter((l) => l.approved).length;
  console.log(
    `[seed] ${LEAVES.length} pengajuan (${approved} disetujui, ${LEAVES.length - approved} menunggu persetujuan)`
  );
}

async function insertReimburses() {
  const admin = await db.queryOne(`SELECT id FROM app_users WHERE username = 'admin' LIMIT 1`);
  const reviewerId = admin ? admin.id : null;

  for (const r of REIMBURSES) {
    await db.execute(
      `INSERT INTO reimburses
         (employee_id, description, amount, status, reviewed_by, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        r.employee,
        r.description,
        r.amount,
        r.status,
        r.status === 'pending' ? null : reviewerId,
        r.reviewed_at,
        r.reviewed_at || `${TO} 08:00:00`,
      ]
    );
  }
  console.log(`[seed] ${REIMBURSES.length} pengajuan reimburse`);
}

(async () => {
  console.log('===============================================');
  console.log(' SEED DATA DUMMY - JADWAL GLOBAL');
  console.log(` Periode: ${FROM} s/d ${TO}`);
  console.log('===============================================');

  await backup();
  await clear();
  await applySettings();
  await applyEmployees();
  await insertLogs();
  await insertWeekendSchedules();
  await insertLeaves();
  await insertReimburses();

  const result = await attendance.generate({ from: FROM, to: TO });
  console.log('[seed] Rekap harian:', result.message);

  const summary = await attendance.summary({ from: FROM, to: TO });
  console.log('[seed] Total:', JSON.stringify(summary.totals));
  console.log('[seed] Per status:', JSON.stringify(summary.by_status));
  console.log('[seed] Selesai.');

  await db.closePool();
})().catch(async (err) => {
  console.error('[seed] GAGAL:', err.message);
  try { await db.closePool(); } catch { /* ignore */ }
  process.exit(1);
});