'use strict';

/**
 * Upgrade skema untuk database yang SUDAH ADA.
 *
 * db/schema.sql memakai CREATE TABLE IF NOT EXISTS, jadi tidak mengubah tabel
 * lama. File ini menambahkan kolom/enum baru secara idempotent (aman dijalankan
 * berulang kali) agar instalasi lama ikut punya fitur portal karyawan.
 *
 * Semua query dijaga hanya dijalankan bila obyeknya benar-benar ada, sehingga
 * modul ini aman dipanggil pada database kosong sebelum schema.sql dijalankan.
 */

const ENUM_ROLE = "ENUM('admin','hr','operator','viewer','employee') NOT NULL DEFAULT 'viewer'";
const ENUM_LEAVE_TYPE =
  "ENUM('izin','sakit','cuti','izin_meninggal','dinas_luar','dinas_dalam') NOT NULL DEFAULT 'izin'";
const ENUM_DAILY_STATUS =
  "ENUM('hadir','telat','izin','sakit','cuti','alpa','belum','hari_libur','dinas_luar','dinas_dalam')";

const changes = [];

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return Number(rows[0].total) > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number(rows[0].total) > 0;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return Number(rows[0].total) > 0;
}

async function fkExists(conn, table, constraint) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table, constraint]
  );
  return Number(rows[0].total) > 0;
}

/** Hapus FK lama dengan nama lain yang menunjuk kolom tertentu. */
async function dropForeignKeysOn(conn, table, column, keepName) {
  const [rows] = await conn.query(
    `SELECT kcu.CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = ?
        AND kcu.COLUMN_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND kcu.CONSTRAINT_NAME <> ?`,
    [table, column, keepName]
  );
  for (const row of rows) {
    await conn.query(
      `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``
    );
    changes.push(`drop FK ${table}.${column} (${row.CONSTRAINT_NAME})`);
  }
}

/** Ubah tipe kolom hanya bila definisinya belum sama. */
async function modifyColumnIfNeeded(conn, table, column, definition, expectToken) {
  const [rows] = await conn.query(
    `SELECT COLUMN_TYPE AS column_type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0 && String(rows[0].column_type).includes(expectToken)) return;
  await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  changes.push(`${table}.${column} enum`);
}

async function upgradeAppUsers(conn) {
  if (!(await tableExists(conn, 'app_users'))) return;

  if (!(await columnExists(conn, 'app_users', 'employee_id'))) {
    await conn.query(
      'ALTER TABLE `app_users` ADD COLUMN `employee_id` INT UNSIGNED NULL AFTER `role`'
    );
    changes.push('app_users.employee_id');
  }

  await modifyColumnIfNeeded(conn, 'app_users', 'role', ENUM_ROLE, "'employee'");

  if (!(await indexExists(conn, 'app_users', 'ix_app_users_employee'))) {
    await conn.query('ALTER TABLE `app_users` ADD KEY `ix_app_users_employee` (`employee_id`)');
    changes.push('app_users.ix_app_users_employee');
  }

  // Unik per karyawan, tapi hanya bila belum ada index unik lain di kolom itu.
  const [unique] = await conn.query(
    `SELECT COUNT(*) AS total FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'app_users'
        AND COLUMN_NAME = 'employee_id' AND NON_UNIQUE = 0`
  );
  if (
    Number(unique[0].total) === 0 &&
    !(await indexExists(conn, 'app_users', 'uq_app_users_employee'))
  ) {
    await conn.query('ALTER TABLE `app_users` ADD UNIQUE KEY `uq_app_users_employee` (`employee_id`)');
    changes.push('app_users.uq_app_users_employee');
  }

  if (await tableExists(conn, 'employees')) {
    // Buang hanya FK dengan nama yang tidak sesuai (mis. sisa instalasi lama),
    // lalu pasang ulang bila nama standarnya belum ada.
    await dropForeignKeysOn(conn, 'app_users', 'employee_id', 'fk_app_users_employee');
    if (!(await fkExists(conn, 'app_users', 'fk_app_users_employee'))) {
      await conn.query(
        `ALTER TABLE \`app_users\`
           ADD CONSTRAINT \`fk_app_users_employee\`
           FOREIGN KEY (\`employee_id\`) REFERENCES \`employees\` (\`id\`)
           ON UPDATE CASCADE ON DELETE SET NULL`
      );
      changes.push('app_users.fk_app_users_employee');
    }
  }
}

async function upgradeLeaveRequests(conn) {
  if (!(await tableExists(conn, 'leave_requests'))) return;
  await modifyColumnIfNeeded(
    conn,
    'leave_requests',
    'leave_type',
    ENUM_LEAVE_TYPE,
    "'dinas_dalam'"
  );

  // Sub-jenis rinci + lokasi dinas untuk form pengajuan bertingkat.
  if (!(await columnExists(conn, 'leave_requests', 'subtype'))) {
    await conn.query(
      'ALTER TABLE `leave_requests` ADD COLUMN `subtype` VARCHAR(50) NULL AFTER `leave_type`'
    );
    changes.push('leave_requests.subtype');
  }

  if (!(await columnExists(conn, 'leave_requests', 'place'))) {
    await conn.query(
      'ALTER TABLE `leave_requests` ADD COLUMN `place` VARCHAR(150) NULL AFTER `subtype`'
    );
    changes.push('leave_requests.place');
  }

  // Transportasi + nomor surat perjalanan dinas (diisi saat/after approve).
  if (!(await columnExists(conn, 'leave_requests', 'transport'))) {
    await conn.query(
      'ALTER TABLE `leave_requests` ADD COLUMN `transport` VARCHAR(150) NULL AFTER `attachment`'
    );
    changes.push('leave_requests.transport');
  }

  if (!(await columnExists(conn, 'leave_requests', 'travel_letter_no'))) {
    await conn.query(
      'ALTER TABLE `leave_requests` ADD COLUMN `travel_letter_no` VARCHAR(60) NULL AFTER `transport`'
    );
    changes.push('leave_requests.travel_letter_no');
  }
}

async function upgradeAttendanceDaily(conn) {
  if (!(await tableExists(conn, 'attendance_daily'))) return;
  await modifyColumnIfNeeded(
    conn,
    'attendance_daily',
    'status',
    ENUM_DAILY_STATUS,
    "'dinas_dalam'"
  );
}

async function upgradeEmployees(conn) {
  if (!(await tableExists(conn, 'employees'))) return;

  // Jatah cuti tahunan: diinput manual admin/HR, berkurang saat pengajuan
  // cuti tahunan disetujui. Nilai default 0 supaya karyawan lama tidak suddenly
  // punya jatah tak terduga.
  const columns = [
    ['annual_leave_quota', '`annual_leave_quota` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `fingerprint_status`'],
    ['annual_leave_used', '`annual_leave_used` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `annual_leave_quota`'],
    ['annual_leave_reset_at', '`annual_leave_reset_at` DATETIME NULL AFTER `annual_leave_used`'],
  ];

  for (const [name, definition] of columns) {
    if (await columnExists(conn, 'employees', name)) continue;
    await conn.query(`ALTER TABLE \`employees\` ADD COLUMN ${definition}`);
    changes.push(`employees.${name}`);
  }
}

/**
 * Periksa shifts.work_days yang tersimpan memakai indeks UI versi lama (0-6).
 *
 * UI lama mengirim index App.DAY_NAMES (0=Minggu..6=Sabtu) sementara server
 * memvalidasi ISO 1-7. Karena urutan"Senin..Sabtu" kebetulan sama di kedua
 * konvensi, angka 1-6 tidak rusak; yang hilang hanya hari Minggu (terkirim
 * "0" lalu dibuang). Nilai yang sudah tersimpan tidak bisa ditebak maksudnya,
 * jadi migrate hanya MEMBERITAKAN baris bermasalah lewat log, tanpa mengubah
 * data diam-diam.
 */
async function auditShiftWorkDays(conn) {
  if (!(await tableExists(conn, 'shifts'))) return;

  const [rows] = await conn.query('SELECT id, code, name, work_days FROM shifts');
  const suspect = [];

  for (const row of rows) {
    const parts = String(row.work_days || '')
      .split(',')
      .map((v) => Number.parseInt(v.trim(), 10));
    const invalid = parts.filter((n) => !Number.isInteger(n) || n < 1 || n > 7);

    if (invalid.length > 0) {
      suspect.push({ ...row, reason: `nilai di luar 1-7: ${invalid.join(', ')}` });
    } else if (parts.length === 0) {
      suspect.push({ ...row, reason: 'kosong' });
    }
  }

  if (suspect.length === 0) return;

  console.log('[migrate] PERHATIAN: shifts.work_days berikut tidak valid dan perlu diperbaiki manual:');
  for (const row of suspect) {
    console.log(`[migrate]   - #${row.id} ${row.code} "${row.name}" = "${row.work_days}" (${row.reason})`);
  }
  console.log('[migrate]   Nilai tidak diubah otomatis karena hanya admin yang tahu maksud sebenarnya.');
  console.log('[migrate]   Catatan: shift hasil UI versi lama mungkin kehilangan hari Minggu tanpa jejak.');
}

async function upgradeNotifications(conn) {
  if (await tableExists(conn, 'notifications')) return;
  // Tabel ini hanya upgraded, bukan dibuat di sini: pada database kosong
  // app_users belum ada (schema.sql baru dijalankan setelah upgrades), jadi
  // FK ke app_users akan gagal dengan errno 150 dan membatalkan migrate.
  if (!(await tableExists(conn, 'app_users'))) return;
  await conn.query(
    `CREATE TABLE \`notifications\` (
       \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       \`user_id\` INT UNSIGNED NOT NULL,
       \`kind\` VARCHAR(30) NOT NULL,
       \`title\` VARCHAR(150) NOT NULL,
       \`body\` VARCHAR(500) NULL,
       \`entity\` VARCHAR(30) NULL,
       \`entity_id\` INT UNSIGNED NULL,
       \`is_read\` TINYINT(1) NOT NULL DEFAULT 0,
       \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (\`id\`),
       KEY \`ix_notif_user\` (\`user_id\`, \`is_read\`, \`id\`),
       CONSTRAINT \`fk_notif_user\` FOREIGN KEY (\`user_id\`)
         REFERENCES \`app_users\` (\`id\`) ON DELETE CASCADE
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  changes.push('notifications');
}

async function upgradeDutyCheckins(conn) {
  if (!(await tableExists(conn, 'duty_checkins'))) return;
  if (!(await columnExists(conn, 'duty_checkins', 'checkout_selfie_path'))) {
    await conn.query(
      'ALTER TABLE `duty_checkins` ADD COLUMN `checkout_selfie_path` VARCHAR(255) NULL AFTER `selfie_path`'
    );
    changes.push('duty_checkins.checkout_selfie_path');
  }
}

async function upgradeLeaveQuotaLogs(conn) {
  if (!(await tableExists(conn, 'leave_requests'))) return;

  // Menyimpan berapa hari yang sudah dipotong per pengajuan supaya pengajuan
  // yang dibalik statusnya (approved -> rejected) mengembalikan jumlah yang sama.
  if (!(await columnExists(conn, 'leave_requests', 'quota_days'))) {
    await conn.query(
      'ALTER TABLE `leave_requests` ADD COLUMN `quota_days` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `review_note`'
    );
    changes.push('leave_requests.quota_days');
  }
}

/**
 * Terapkan seluruh upgrade. Wajib dipanggil SESUDAH `USE <database>` dan
 * SEBELUM schema.sql dieksekusi (schema.sql menambahkan FK di akhir).
 */
async function applyUpgrades(conn) {
  await upgradeAppUsers(conn);
  await upgradeEmployees(conn);
  await upgradeLeaveRequests(conn);
  await upgradeLeaveQuotaLogs(conn);
  await upgradeDutyCheckins(conn);
  await upgradeNotifications(conn);
  await upgradeAttendanceDaily(conn);
  await auditShiftWorkDays(conn);

  if (changes.length > 0) {
    console.log('[migrate] Upgrade skema instalasi lama:');
    for (const item of changes) console.log(`[migrate]   - ${item}`);
  } else {
    console.log('[migrate] Skema sudah versi terbaru, tidak ada upgrade.');
  }

  return changes;
}

module.exports = { applyUpgrades };