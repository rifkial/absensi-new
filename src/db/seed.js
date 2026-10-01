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

const SHIFTS = [
  {
    code: 'PAGI',
    name: 'Shift Pagi (08:00-17:00)',
    start_time: '08:00',
    end_time: '17:00',
    break_start: '12:00',
    break_end: '13:00',
    late_tolerance_min: 10,
    work_days: '1,2,3,4,5',
  },
  {
    code: 'SIANG',
    name: 'Shift Siang (14:00-23:00)',
    start_time: '14:00',
    end_time: '23:00',
    break_start: '18:00',
    break_end: '19:00',
    late_tolerance_min: 10,
    work_days: '1,2,3,4,5',
  },
  {
    code: 'MALAM',
    name: 'Shift Malam (22:00-06:00)',
    start_time: '22:00',
    end_time: '06:00',
    break_start: null,
    break_end: null,
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

module.exports = { seed, DEPARTMENTS, POSITIONS, SHIFTS };
