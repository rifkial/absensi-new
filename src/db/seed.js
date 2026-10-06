'use strict';

const db = require('./pool');
const auth = require('../middleware/auth');
const notify = require('../services/notify');

/**
 * Seed data awal: akun admin, unit kerja, jabatan, shift contoh,
 * template pesan notifikasi, dan pengaturan default.
 *
 * Aman dijalankan berulang kali karena memakai INSERT ... ON DUPLICATE KEY.
 */

const DEFAULT_ADMIN = {
  username: 'admin',
  password: 'admin123',
  full_name: 'Administrator',
  role: 'admin',
};

const DEPARTMENTS = [
  { code: 'ADM', name: 'Administrasi' },
  { code: 'PRD', name: 'Produksi' },
  { code: 'SLS', name: 'Penjualan' },
  { code: 'HRD', name: 'Human Resource' },
  { code: 'FIN', name: 'Keuangan' },
];

const POSITIONS = [
  { code: 'MGR', name: 'Manajer' },
  { code: 'SUP', name: 'Supervisor' },
  { code: 'STF', name: 'Staff' },
  { code: 'OPR', name: 'Operator' },
  { code: 'DRV', name: 'Sopir' },
];

/**
 * Shift bawaan mengikuti pola umum 3 shift:
 * Pagi 07:00-15:00, Siang 15:00-23:00, Malam 23:00-07:00 (lintas hari).
 * Shift malam = jam selesai <= jam mulai, pulang tercatat di tanggal berikut.
 */
const SHIFTS = [
  {
    code: 'PAGI',
    name: 'Shift Pagi (07:00-15:00)',
    start_time: '07:00',
    end_time: '15:00',
    break_start: '11:00',
    break_end: '11:30',
    late_tolerance_min: 15,
    work_days: '1,2,3,4,5',
  },
  {
    code: 'SIANG',
    name: 'Shift Siang (15:00-23:00)',
    start_time: '15:00',
    end_time: '23:00',
    break_start: '19:00',
    break_end: '19:30',
    late_tolerance_min: 15,
    work_days: '1,2,3,4,5',
  },
  {
    code: 'MALAM',
    name: 'Shift Malam (23:00-07:00)',
    start_time: '23:00',
    end_time: '07:00',
    break_start: '03:00',
    break_end: '03:30',
    late_tolerance_min: 15,
    work_days: '1,2,3,4,5,6,7',
  },
  {
    code: 'FLEK',
    name: 'Shift Fleksibel (09:00-18:00)',
    start_time: '09:00',
    end_time: '18:00',
    break_start: '13:00',
    break_end: '14:00',
    late_tolerance_min: 15,
    work_days: '1,2,3,4,5,6',
  },
];

const DEMO_EMPLOYEES = [
  { code: '001', pin: '1', name: 'Ahmad Fauzi', gender: 'L', dept: 'ADM', pos: 'STF', shift: 'PAGI', phone: '08120111001', email: 'ahmad@contoh.com', hire_date: '2023-01-10' },
  { code: '002', pin: '2', name: 'Siti Aminah', gender: 'P', dept: 'ADM', pos: 'STF', shift: 'PAGI', phone: '08120111002', email: 'siti@contoh.com', hire_date: '2023-02-01' },
  { code: '003', pin: '3', name: 'Budi Santoso', gender: 'L', dept: 'PRD', pos: 'SUP', shift: 'PAGI', phone: '08120111003', email: 'budi@contoh.com', hire_date: '2022-06-15' },
  { code: '004', pin: '4', name: 'Dewi Lestari', gender: 'P', dept: 'PRD', pos: 'OPR', shift: 'SIANG', phone: '08120111004', email: 'dewi@contoh.com', hire_date: '2023-08-20' },
  { code: '005', pin: '5', name: 'Eko Prasetyo', gender: 'L', dept: 'SLS', pos: 'STF', shift: 'MALAM', phone: '08120111005', email: 'eko@contoh.com', hire_date: '2024-01-05' },
];

/**
 * Contoh pola jadwal seperti alur umum: Budi Pagi 2 hari, libur 1 hari,
 * lalu Malam. Dijalankan relatif ke hari ini supaya selalu relevan.
 */
async function seedDemoSchedules(db, shiftByCode) {
  const { toDate, addDays } = require('../utils/date');
  const budi = await db.queryOne('SELECT id FROM employees WHERE employee_code = ?', ['003']);
  if (!budi) return;
  const t = toDate(new Date());
  const pattern = [
    { offset: 0, shift: 'PAGI', day_type: 'kerja', note: 'Jadwal Pagi' },
    { offset: 1, shift: 'PAGI', day_type: 'kerja', note: 'Jadwal Pagi' },
    { offset: 2, shift: null, day_type: 'libur', note: 'Libur mingguan' },
    { offset: 3, shift: 'MALAM', day_type: 'kerja', note: 'Jadwal Malam (lintas hari)' },
  ];
  for (const p of pattern) {
    await db.execute(
      `INSERT INTO schedules (employee_id, work_date, shift_id, day_type, note)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE shift_id = VALUES(shift_id), day_type = VALUES(day_type), note = VALUES(note)`,
      [budi.id, addDays(t, p.offset), p.shift ? shiftByCode[p.shift] || null : null, p.day_type, p.note]
    );
  }
  console.log('[seed] Contoh jadwal Budi (Pagi, Pagi, Libur, Malam) siap.');
}

const SETTINGS = {
  app_name: 'Aplikasi Absensi Fingerprint',
  company_name: 'PT Contoh Sejahtera',
  late_reminder_time: '09:00',
  daily_notify_time: '18:00',
  monthly_report_day: '1',
};

async function seed() {
  console.log('[seed] Mulai...');

  // 1) Akun admin
  const existingAdmin = await auth.findUserByUsername(DEFAULT_ADMIN.username);
  if (existingAdmin) {
    console.log(`[seed] Akun "${DEFAULT_ADMIN.username}" sudah ada, dilewati.`);
  } else {
    await db.execute(
      'INSERT INTO app_users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [
        DEFAULT_ADMIN.username,
        await auth.hashPassword(DEFAULT_ADMIN.password),
        DEFAULT_ADMIN.full_name,
        DEFAULT_ADMIN.role,
      ]
    );
    console.log(`[seed] Akun admin dibuat. User: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}`);
    console.log('[seed] !!! GANTI PASSWORD INI SETELAH LOGIN PERTAMA !!!');
  }

  // 2) Unit kerja
  for (const dept of DEPARTMENTS) {
    await db.execute(
      'INSERT INTO departments (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [dept.code, dept.name]
    );
  }
  console.log(`[seed] ${DEPARTMENTS.length} unit kerja siap.`);

  // 3) Jabatan
  for (const pos of POSITIONS) {
    await db.execute(
      'INSERT INTO positions (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [pos.code, pos.name]
    );
  }
  console.log(`[seed] ${POSITIONS.length} jabatan siap.`);

  // 4) Shift
  for (const shift of SHIFTS) {
    await db.execute(
      `INSERT INTO shifts
         (code, name, start_time, end_time, break_start, break_end, late_tolerance_min, work_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         start_time = VALUES(start_time),
         end_time = VALUES(end_time),
         break_start = VALUES(break_start),
         break_end = VALUES(break_end),
         late_tolerance_min = VALUES(late_tolerance_min),
         work_days = VALUES(work_days)`,
      [
        shift.code,
        shift.name,
        shift.start_time,
        shift.end_time,
        shift.break_start,
        shift.break_end,
        shift.late_tolerance_min,
        shift.work_days,
      ]
    );
  }
  console.log(`[seed] ${SHIFTS.length} shift siap.`);

  // 4b) Karyawan demo (idempoten via employee_code)
  const deptRows = await db.queryAll('SELECT id, code FROM departments');
  const posRows = await db.queryAll('SELECT id, code FROM positions');
  const shiftRows = await db.queryAll('SELECT id, code FROM shifts');
  const deptByCode = Object.fromEntries(deptRows.map((r) => [r.code, r.id]));
  const posByCode = Object.fromEntries(posRows.map((r) => [r.code, r.id]));
  const shiftByCode = Object.fromEntries(shiftRows.map((r) => [r.code, r.id]));
  for (const emp of DEMO_EMPLOYEES) {
    await db.execute(
      `INSERT INTO employees
         (employee_code, device_user_id, name, gender, department_id, position_id,
          shift_id, phone, email, hire_date, status, fingerprint_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aktif', 'belum')
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), gender = VALUES(gender),
         department_id = VALUES(department_id), position_id = VALUES(position_id),
         shift_id = VALUES(shift_id), phone = VALUES(phone), email = VALUES(email)`,
      [
        emp.code, emp.pin, emp.name, emp.gender,
        deptByCode[emp.dept] || null, posByCode[emp.pos] || null,
        shiftByCode[emp.shift] || null, emp.phone, emp.email, emp.hire_date,
      ]
    );
  }
  console.log(`[seed] ${DEMO_EMPLOYEES.length} karyawan demo siap.`);
  await seedDemoSchedules(db, shiftByCode);

  // 5) Template notifikasi
  for (const [eventKey, tpl] of Object.entries(notify.DEFAULT_TEMPLATES)) {
    for (const channel of ['whatsapp', 'email']) {
      await db.execute(
        `INSERT INTO notification_templates (event_key, channel, subject, body)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)`,
        [eventKey, channel, tpl.subject, tpl.body]
      );
    }
  }
  console.log('[seed] Template notifikasi siap.');

  // 6) Pengaturan dasar
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.execute(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value]
    );
  }
  console.log(`[seed] ${Object.keys(SETTINGS).length} pengaturan dasar siap.`);

  // 7) Ringkasan
  const summary = await db.queryOne(
    `SELECT
       (SELECT COUNT(*) FROM app_users) AS users,
       (SELECT COUNT(*) FROM departments) AS departments,
       (SELECT COUNT(*) FROM positions) AS positions,
       (SELECT COUNT(*) FROM shifts) AS shifts,
       (SELECT COUNT(*) FROM employees) AS employees,
       (SELECT COUNT(*) FROM devices) AS devices`
  );

  console.log('[seed] Ringkasan:');
  console.table(summary);
  console.log('[seed] Selesai.');
}

if (require.main === module) {
  seed()
    .then(async () => {
      await db.closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[seed] GAGAL:', err.message);
      await db.closePool().catch(() => {});
      process.exit(1);
    });
}

module.exports = { seed, DEPARTMENTS, POSITIONS, SHIFTS, DEMO_EMPLOYEES };
