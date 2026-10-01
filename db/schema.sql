-- ============================================================================
--  APLIKASI ABSENSI FINGERPRINT - SKEMA DATABASE
--  Target: MySQL 5.7+ / MariaDB 10.4+ (XAMPP)
--  Jalankan: npm run migrate
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Akun pengguna aplikasi
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- 1. Akun pengguna aplikasi
--    employee_id diisi bila akun ini adalah portal mandiri seorang karyawan
--    (role 'employee'), sehingga dia hanya melihat datanya sendiri.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name     VARCHAR(100) NOT NULL,
  role          ENUM('admin','hr','operator','viewer','employee') NOT NULL DEFAULT 'viewer',
  employee_id   INT UNSIGNED NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_app_users_username (username),
  UNIQUE KEY uq_app_users_employee (employee_id),
  KEY ix_app_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Unit kerja & jabatan
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(20)  NOT NULL,
  name       VARCHAR(100) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS positions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(20)  NOT NULL,
  name       VARCHAR(100) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_positions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Shift kerja
--    work_days: daftar hari kerja (1=Minggu ... 7=Sabtu), dipisah koma
--    contoh "1,2,3,4,5" = Senin-Jumat
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  id                    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code                  VARCHAR(20)   NOT NULL,
  name                  VARCHAR(100)  NOT NULL,
  start_time            TIME          NOT NULL,
  end_time              TIME          NOT NULL,
  break_start           TIME          NULL,
  break_end             TIME          NULL,
  late_tolerance_min    SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  max_work_minutes      SMALLINT UNSIGNED NULL COMMENT 'NULL = pakai default global',
  work_days             VARCHAR(20)   NOT NULL DEFAULT '1,2,3,4,5',
  half_day              TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = tipe half day (cuti potong)',
  is_active             TINYINT(1)    NOT NULL DEFAULT 1,
  created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shifts_code (code),
  KEY ix_shifts_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Karyawan
--    device_user_id = PIN / UserID yang terdaftar di mesin fingerprint
--    shift_id       = shift default (bisa dioverride per tanggal via schedules)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_code       VARCHAR(30)  NOT NULL COMMENT 'NIK / kode karyawan internal',
  device_user_id      VARCHAR(50)  NULL     COMMENT 'PIN pada mesin fingerprint',
  name                VARCHAR(120) NOT NULL,
  gender              ENUM('L','P') NULL,
  department_id       INT UNSIGNED NULL,
  position_id         INT UNSIGNED NULL,
  shift_id            INT UNSIGNED NULL,
  phone               VARCHAR(25)  NULL,
  email               VARCHAR(120) NULL,
  address             VARCHAR(255) NULL,
  photo_path          VARCHAR(255) NULL,
  hire_date           DATE         NULL,
  status              ENUM('aktif','nonaktif','resign') NOT NULL DEFAULT 'aktif',
  fingerprint_status  ENUM('belum','terdaftar','gagal') NOT NULL DEFAULT 'belum'
                      COMMENT 'Status enrollment sidik jari di mesin',
  notes               TEXT         NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_code (employee_code),
  UNIQUE KEY uq_employees_device_user (device_user_id),
  KEY ix_employees_dept (department_id),
  KEY ix_employees_status (status),
  KEY ix_employees_name (name),
  CONSTRAINT fk_employees_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_position   FOREIGN KEY (position_id)   REFERENCES positions   (id) ON DELETE SET NULL,
  CONSTRAINT fk_employees_shift      FOREIGN KEY (shift_id)      REFERENCES shifts      (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Jadwal kerja per karyawan per tanggal (override shift / hari libur)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedules (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id INT UNSIGNED NOT NULL,
  work_date   DATE         NOT NULL,
  shift_id    INT UNSIGNED NULL COMMENT 'NULL = pakai shift default karyawan',
  day_type    ENUM('kerja','libur','cuti') NOT NULL DEFAULT 'kerja',
  note        VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_schedules_emp_date (employee_id, work_date),
  KEY ix_schedules_date (work_date),
  CONSTRAINT fk_schedules_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_schedules_shift    FOREIGN KEY (shift_id)    REFERENCES shifts    (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Pengajuan izin / sakit / cuti
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id  INT UNSIGNED NOT NULL,
  leave_type   ENUM('izin','sakit','cuti','izin_meninggal','dinas_luar','dinas_dalam') NOT NULL DEFAULT 'izin'
               COMMENT 'dinas_luar = tugas lapangan GPS+selfie, dinas_dalam = tugas dalam kota',
  subtype      VARCHAR(50)  NULL
               COMMENT 'sub-jenis rinci, mis. cuti_melahirkan / izin_keluarga / dinas_luar_kota',
  place        VARCHAR(150) NULL
               COMMENT 'lokasi/tujuan dinas',
  start_date   DATE         NOT NULL,
  end_date     DATE         NOT NULL,
  reason       VARCHAR(500) NULL,
  attachment   VARCHAR(255) NULL,
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by  INT UNSIGNED NULL,
  reviewed_at  DATETIME     NULL,
  review_note  VARCHAR(500) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_leave_emp_date (employee_id, start_date, end_date),
  KEY ix_leave_status (status),
  CONSTRAINT fk_leave_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_leave_reviewer FOREIGN KEY (reviewed_by)  REFERENCES app_users  (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. Perangkat fingerprint
--    protocol: 'zkteco-tcp'  -> polling TCP (port 4370)
--              'push-http'   -> mesin PUSH ke server (ADMS/icLock HTTP)
--              'csv'         -> impor manual file
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(100) NOT NULL,
  protocol          ENUM('zkteco-tcp','push-http','csv') NOT NULL DEFAULT 'zkteco-tcp',
  ip_address        VARCHAR(45)  NULL,
  port              SMALLINT UNSIGNED NOT NULL DEFAULT 4370,
  location          VARCHAR(150) NULL,
  serial_number     VARCHAR(60)  NULL COMMENT 'SN mesin, diisi otomatis saat handshake PUSH',
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  auto_sync         TINYINT(1)   NOT NULL DEFAULT 1,
  sync_interval_min SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  last_sync_at      DATETIME     NULL,
  last_sync_status  ENUM('idle','success','failed','running') NOT NULL DEFAULT 'idle',
  last_sync_message VARCHAR(500) NULL,
  last_device_info  TEXT         NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_name (name),
  KEY ix_devices_active (is_active, auto_sync)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. Log absensi mentah hasil sinkronisasi dari mesin
--    Kolom unik mencegah log yang sama tercatat 2x (re-sinkron aman)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id      INT UNSIGNED  NULL,
  employee_id    INT UNSIGNED  NULL,
  device_user_id VARCHAR(50)   NOT NULL,
  log_time       DATETIME      NOT NULL,
  log_date       DATE          NOT NULL,
  log_state      SMALLINT      NOT NULL DEFAULT 0
                 COMMENT '0=masuk 1=keluar 2=istirahat 3=... (lihat utils/zkState)',
  verify_mode    SMALLINT      NOT NULL DEFAULT 0
                 COMMENT '0=sidik jari 1=kartu 2=password 3=wajah 4=mesin',
  work_code      VARCHAR(20)   NOT NULL DEFAULT '',
  source         ENUM('sync','push','import','manual') NOT NULL DEFAULT 'sync',
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_dedupe (device_id, device_user_id, log_time, verify_mode, work_code),
  KEY ix_att_logs_date (log_date),
  KEY ix_att_logs_emp (employee_id, log_time),
  KEY ix_att_logs_device (device_id, log_time),
  CONSTRAINT fk_att_logs_device   FOREIGN KEY (device_id)   REFERENCES devices   (id) ON DELETE SET NULL,
  CONSTRAINT fk_att_logs_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 9. Template sidik jari (diambil dari mesin, agar bisa dikirim ulang / arsip)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fingerprint_templates (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id  INT UNSIGNED   NOT NULL,
  device_id    INT UNSIGNED   NULL,
  finger_index TINYINT UNSIGNED NOT NULL DEFAULT 0
               COMMENT '0=kiri jari kelingking ... 5=kanan jempol (lihat utils/biometric)',
  valid        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  size_bytes   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  template     MEDIUMBLOB     NULL,
  created_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fp_emp_finger (employee_id, finger_index),
  CONSTRAINT fk_fp_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_fp_device   FOREIGN KEY (device_id)   REFERENCES devices   (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 10. Rekap absensi harian (hasil perhitungan, bukan data mentah)
--     status: hadir | telat | izin | sakit | cuti | alpa | belum | hari_libur
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_daily (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id      INT UNSIGNED NOT NULL,
  work_date        DATE         NOT NULL,
  shift_id         INT UNSIGNED NULL,
  shift_code       VARCHAR(20)  NULL,
  first_in         DATETIME     NULL,
  first_out        DATETIME     NULL,
  late_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  early_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  work_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  overtime_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  scan_count       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status           ENUM('hadir','telat','izin','sakit','cuti','alpa','belum','hari_libur','dinas_luar','dinas_dalam')
                    NOT NULL DEFAULT 'belum'
                    COMMENT 'dinas_luar / dinas_dalam = tugas dinas, dihitung hadir',
  is_auto          TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1=hasil sistem, 0=diubah manual',
  note             VARCHAR(500) NULL,
  generated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_emp_date (employee_id, work_date),
  KEY ix_daily_date (work_date),
  KEY ix_daily_status (work_date, status),
  KEY ix_daily_shift (shift_id),
  CONSTRAINT fk_daily_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_daily_shift    FOREIGN KEY (shift_id)    REFERENCES shifts    (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 11. Riwayat sinkronisasi
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id    INT UNSIGNED   NULL,
  started_at   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME       NULL,
  duration_ms  INT UNSIGNED   NULL,
  status       ENUM('running','success','partial','failed') NOT NULL DEFAULT 'running',
  fetched      INT UNSIGNED   NOT NULL DEFAULT 0,
  inserted     INT UNSIGNED   NOT NULL DEFAULT 0,
  duplicated   INT UNSIGNED   NOT NULL DEFAULT 0,
  unmatched    INT UNSIGNED   NOT NULL DEFAULT 0 COMMENT 'PIN mesin tidak ada di master karyawan',
  message      VARCHAR(500)   NULL,
  PRIMARY KEY (id),
  KEY ix_sync_device (device_id, started_at),
  CONSTRAINT fk_sync_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 12. Pengaturan key-value yang bisa diubah dari UI
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(60)  NOT NULL,
  setting_value TEXT         NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 13. Template pesan notifikasi
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_templates (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_key    VARCHAR(50)  NOT NULL COMMENT 'daily_reminder | late_notice | sync_failed | monthly_report',
  channel      ENUM('email','whatsapp') NOT NULL DEFAULT 'whatsapp',
  subject      VARCHAR(150) NULL,
  body         TEXT         NOT NULL,
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notif_tpl (event_key, channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 14. Log audit untuk perubahan data sensitif
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED   NULL,
  action      VARCHAR(60)    NOT NULL,
  entity      VARCHAR(60)    NULL,
  entity_id   VARCHAR(60)    NULL,
  detail      TEXT           NULL,
  ip_address  VARCHAR(45)    NULL,
  created_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_user (user_id, created_at),
  KEY ix_audit_entity (entity, entity_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 15. Tampilan bantu rekap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_attendance_overview AS
SELECT
  d.id            AS daily_id,
  e.id            AS employee_id,
  e.employee_code,
  e.name          AS employee_name,
  dep.id          AS department_id,
  dep.name        AS department_name,
  pos.name        AS position_name,
  e.device_user_id,
  d.work_date,
  d.shift_id,
  d.shift_code,
  s.start_time,
  s.end_time,
  d.first_in,
  d.first_out,
  d.late_minutes,
  d.early_minutes,
  d.work_minutes,
  d.overtime_minutes,
  d.scan_count,
  d.status,
  d.is_auto,
  d.note
FROM attendance_daily d
JOIN employees   e   ON e.id = d.employee_id
LEFT JOIN departments dep ON dep.id = e.department_id
LEFT JOIN positions   pos ON pos.id = e.position_id
LEFT JOIN shifts      s   ON s.id = d.shift_id;

-- ---------------------------------------------------------------------------
-- 16. Absen dinas luar kota (tugas lapangan)
--     Karyawan tidak bisa scan finger di lapangan, jadi absen dilakukan lewat
--     portal: ambil koordinat GPS + jam check-in + foto selfie.
--     Satu baris per karyawan per tanggal (menggantikan scan fingerprint).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS duty_checkins (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id    INT UNSIGNED NOT NULL,
  work_date      DATE         NOT NULL,
  check_in_at    DATETIME     NOT NULL COMMENT 'Jam check-in dari perangkat',
  check_out_at   DATETIME     NULL     COMMENT 'Jam check-out (opsional, diisi dari portal)',
  latitude       DECIMAL(10,7) NULL    COMMENT 'Koordinat lintang -90..90',
  longitude      DECIMAL(10,7) NULL    COMMENT 'Koordinat bujur -180..180',
  accuracy_m     SMALLINT UNSIGNED NULL COMMENT 'Akurasi GPS dalam meter',
  address        VARCHAR(255) NULL     COMMENT 'Alamat hasil reverse geocode',
  selfie_path    VARCHAR(255) NULL     COMMENT 'Lokasi file foto selfie',
  note           VARCHAR(500) NULL     COMMENT 'Keterangan tugas',
  leave_id       INT UNSIGNED NULL     COMMENT 'Pengajuan dinas_luar terkait',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_duty_emp_date (employee_id, work_date),
  KEY ix_duty_date (work_date),
  CONSTRAINT fk_duty_employee FOREIGN KEY (employee_id) REFERENCES employees     (id) ON DELETE CASCADE,
  CONSTRAINT fk_duty_leave    FOREIGN KEY (leave_id)    REFERENCES leave_requests(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 17. Foreign key app_users.employee_id
--     Ditambahkan di sini (bukan di definisi tabel) karena tabel employees
--     dibuat setelah app_users. Idempoten: dilewati bila sudah ada.
-- ---------------------------------------------------------------------------
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'app_users'
     AND CONSTRAINT_NAME = 'fk_app_users_employee'
);
SET @fk_sql = IF(@fk_exists > 0,
  'DO 0',
  'ALTER TABLE app_users ADD CONSTRAINT fk_app_users_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE'
);
PREPARE stmt FROM @fk_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
