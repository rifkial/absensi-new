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
--    work_days: daftar hari kerja ISO (1=Senin ... 7=Minggu), dipisah koma
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
  day_times             TEXT          NULL COMMENT 'override jam per hari (JSON): {"6":{"start":"08:00","end":"15:30"}}. kosong = pakai jam utama',
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
  status_karyawan     ENUM('tetap','kontrak','harian_lepas','magang') NOT NULL DEFAULT 'tetap',
  fingerprint_status  ENUM('belum','terdaftar','gagal') NOT NULL DEFAULT 'belum'
                      COMMENT 'Status enrollment sidik jari di mesin',
  annual_leave_quota  SMALLINT UNSIGNED NOT NULL DEFAULT 0
                      COMMENT 'Jatah cuti tahunan (hari kerja), diinput manual admin/HR',
  annual_leave_used   SMALLINT UNSIGNED NOT NULL DEFAULT 0
                      COMMENT 'Cuti tahunan yang sudah terpakai, berkurang saat pengajuan disetujui',
  annual_leave_reset_at DATETIME    NULL
                      COMMENT 'Waktu jatah cuti terakhir dikembalikan penuh oleh admin/HR',
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
  transport    VARCHAR(150) NULL
               COMMENT 'transportasi dinas, mis. mobil dinas B 1234 CD',
  travel_letter_no VARCHAR(60) NULL
               COMMENT 'nomor surat perjalanan dinas',
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by  INT UNSIGNED NULL,
  reviewed_at  DATETIME     NULL,
  review_note  VARCHAR(500) NULL,
  quota_days   SMALLINT UNSIGNED NOT NULL DEFAULT 0
               COMMENT 'Jumlah hari kerja yang dipotong dari jatah cuti tahunan oleh pengajuan ini',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_leave_emp_date (employee_id, start_date, end_date),
  KEY ix_leave_status (status),
  CONSTRAINT fk_leave_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_leave_reviewer FOREIGN KEY (reviewed_by)  REFERENCES app_users  (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. Reimburse karyawan
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reimburses (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id  INT UNSIGNED NOT NULL,
  description  VARCHAR(500) NOT NULL,
  amount       DECIMAL(12,2) NOT NULL DEFAULT 0,
  attachment   VARCHAR(255) NULL,
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by  INT UNSIGNED NULL,
  reviewed_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_reimburse_employee (employee_id),
  KEY ix_reimburse_status (status),
  CONSTRAINT fk_reimburse_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_reimburse_reviewer FOREIGN KEY (reviewed_by)  REFERENCES app_users  (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. Perangkat fingerprint
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
  CONSTRAINT fk_daily_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
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
-- 13b. Inbox notifikasi realtime (SSE)
--     Satu baris per penerima per kejadian: dinas & reimburse create/review.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL COMMENT 'penerima (app_users.id)',
  kind         VARCHAR(30)  NOT NULL COMMENT 'leave.submitted/reviewed, reimburse.submitted/reviewed',
  title        VARCHAR(150) NOT NULL,
  body         VARCHAR(500) NULL,
  entity       VARCHAR(30)  NULL COMMENT 'leave_requests | reimburses',
  entity_id    INT UNSIGNED NULL,
  is_read      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_notif_user (user_id, is_read, id),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE CASCADE
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
LEFT JOIN positions   pos ON pos.id = e.position_id;

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
  selfie_path    VARCHAR(255) NULL     COMMENT 'Lokasi file foto selfie check-in',
  checkout_selfie_path VARCHAR(255) NULL COMMENT 'Lokasi file foto selfie check-out',
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
-- 17. Riwayat perubahan jatah cuti tahunan
--     Catatan audit setiap kali jatah berkurang (cuti tahunan disetujui),
--     dikembalikan (pengajuan ditolak/dibatalkan), atau direset admin/HR.
--     Memakai tabel ini alih-alih menghitung ulang dari leave_requests supaya
--     reset tetap tidak merusak riwayat pengajuan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_quota_logs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id INT UNSIGNED NOT NULL,
  action      ENUM('potong','kembalikan','reset','set_jatah') NOT NULL,
  days        SMALLINT      NOT NULL DEFAULT 0 COMMENT 'Jumlah hari yang berubah (positif additions, negatif untuk pengurangan)',
  quota_before SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  used_before  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  used_after   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  leave_id    INT UNSIGNED NULL COMMENT 'Pengajuan pemicu perubahan',
  reason      VARCHAR(500) NULL,
  actor_id    INT UNSIGNED NULL COMMENT 'Admin/HR yang melakukan perubahan',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_quota_log_employee (employee_id, created_at),
  KEY ix_quota_log_leave (leave_id),
  CONSTRAINT fk_quota_log_employee FOREIGN KEY (employee_id) REFERENCES employees     (id) ON DELETE CASCADE,
  CONSTRAINT fk_quota_log_leave    FOREIGN KEY (leave_id)    REFERENCES leave_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_quota_log_actor    FOREIGN KEY (actor_id)    REFERENCES app_users     (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 18. Hari libur (nasional, cuti bersama, dan tambahan manual admin)
--     source: 'sync'   = hasil sinkronisasi dari API hari libur nasional
--             'manual' = ditambahkan admin/HR sendiri
--     kind  : 'nasional' | 'cuti_bersama' | 'custom'
--     Satu tanggal hanya boleh punya satu baris, jadi admin bisa mengganti
--     nama / jenis libur nasional tanpa menambah duplikat.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  holiday_date  DATE         NOT NULL,
  name          VARCHAR(150) NOT NULL,
  kind          ENUM('nasional','cuti_bersama','custom') NOT NULL DEFAULT 'nasional',
  source        ENUM('sync','manual') NOT NULL DEFAULT 'manual',
  is_workday    TINYINT(1)   NOT NULL DEFAULT 0
                COMMENT '1 = perusahaan tetap bekerja (cuti bersama yang dipakai kerja)',
  note          VARCHAR(255) NULL,
  created_by    INT UNSIGNED NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_holidays_date (holiday_date),
  KEY ix_holidays_source (source),
  CONSTRAINT fk_holidays_actor FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 19. Foreign key app_users.employee_id
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

-- ---------------------------------------------------------------------------
-- 20. Payroll / Penggajian
--     Komponen gaji fleksibel (penghasilan/potongan/beban perusahaan),
--     gaji pokok per karyawan, override komponen per karyawan, periode
--     payroll bulanan, hasil perhitungan per karyawan, dan rincian baris.
--
--     Uang memakai DECIMAL(14,2) supaya tidak ada galat pembulatan biner.
-- ---------------------------------------------------------------------------

-- 20a. Master komponen gaji (template yang bisa dipakai semua karyawan)
CREATE TABLE IF NOT EXISTS payroll_components (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  code          VARCHAR(30)   NOT NULL,
  name          VARCHAR(100)  NOT NULL,
  type          ENUM('penghasilan','potongan','beban_perusahaan') NOT NULL DEFAULT 'penghasilan',
  category      VARCHAR(40)   NOT NULL DEFAULT 'lainnya',
  calc_method   ENUM('tetap','persen','manual','absensi','lembur') NOT NULL DEFAULT 'tetap',
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'nominal utk metode tetap',
  percent       DECIMAL(7,4)  NULL         COMMENT 'persen utk metode persen',
  percent_base  ENUM('gaji_pokok','bruto','tunjangan','penghasilan_netto') NULL COMMENT 'dasar hitung persen',
  rule_json     JSON          NULL         COMMENT 'aturan absensi/lembur, mis. {"per_hadir":20000}',
  taxable       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = masuk dasar PPh 21',
  bpjs_base     TINYINT(1)    NOT NULL DEFAULT 0 COMMENT '1 = masuk dasar iuran BPJS',
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order    INT           NOT NULL DEFAULT 100,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_components_code (code),
  KEY ix_payroll_components_type (type, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20b. Gaji pokok & pengaturan payroll per karyawan
CREATE TABLE IF NOT EXISTS payroll_employee_salary (
  employee_id   INT UNSIGNED  NOT NULL,
  base_salary   DECIMAL(14,2) NOT NULL DEFAULT 0,
  payroll_enabled TINYINT(1)  NOT NULL DEFAULT 1 COMMENT '0 = dikecualikan dari payroll massal',
  effective_date DATE          NULL,
  note          VARCHAR(255)  NULL,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id),
  CONSTRAINT fk_payroll_salary_employee FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20c. Override komponen per karyawan (nominal/persen berbeda dari master)
CREATE TABLE IF NOT EXISTS payroll_employee_components (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  employee_id   INT UNSIGNED  NOT NULL,
  component_id  INT UNSIGNED  NOT NULL,
  amount        DECIMAL(14,2) NULL COMMENT 'override nominal (NULL = pakai master)',
  percent       DECIMAL(7,4)  NULL COMMENT 'override persen (NULL = pakai master)',
  is_active     TINYINT(1)    NULL COMMENT 'override aktif (NULL = pakai master)',
  rule_json     JSON          NULL COMMENT 'override aturan absensi/lembur',
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_emp_component (employee_id, component_id),
  CONSTRAINT fk_payroll_empc_employee  FOREIGN KEY (employee_id)  REFERENCES employees          (id) ON DELETE CASCADE,
  CONSTRAINT fk_payroll_empc_component FOREIGN KEY (component_id) REFERENCES payroll_components (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20d. Periode payroll bulanan (satu periode = satu bulan, satu status)
CREATE TABLE IF NOT EXISTS payroll_periods (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  period_year   SMALLINT      NOT NULL,
  period_month  TINYINT       NOT NULL COMMENT '1-12',
  label         VARCHAR(60)   NULL,
  start_date    DATE          NOT NULL,
  end_date      DATE          NOT NULL,
  status        ENUM('draft','approved','paid') NOT NULL DEFAULT 'draft',
  note          VARCHAR(500)  NULL,
  created_by    INT UNSIGNED  NULL,
  approved_by   INT UNSIGNED  NULL,
  approved_at   DATETIME      NULL,
  paid_at       DATETIME      NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_period (period_year, period_month),
  KEY ix_payroll_period_status (status),
  CONSTRAINT fk_payroll_period_creator  FOREIGN KEY (created_by)  REFERENCES app_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_period_approver FOREIGN KEY (approved_by) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20e. Hasil payroll per karyawan per periode (dikunci setelah approved)
CREATE TABLE IF NOT EXISTS payroll_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_id       INT UNSIGNED  NOT NULL,
  employee_id     INT UNSIGNED  NOT NULL,
  employee_code   VARCHAR(30)   NOT NULL COMMENT 'snapshot saat hitung',
  employee_name   VARCHAR(120)  NOT NULL,
  department_name VARCHAR(100)  NULL,
  position_name   VARCHAR(100)  NULL,
  status          ENUM('draft','approved','paid') NOT NULL DEFAULT 'draft',
  base_salary     DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_earning   DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_deduction DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_company   DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'beban perusahaan (info biaya)',
  net_salary      DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable_base    DECIMAL(14,2) NOT NULL DEFAULT 0,
  bpjs_base       DECIMAL(14,2) NOT NULL DEFAULT 0,
  days_work       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  days_present    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  days_late       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  days_absent     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  days_leave      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  late_minutes    INT UNSIGNED  NOT NULL DEFAULT 0,
  overtime_minutes INT UNSIGNED NOT NULL DEFAULT 0,
  generated_at    DATETIME      NULL,
  calculated_by   INT UNSIGNED  NULL,
  note            VARCHAR(500)  NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payroll_item (period_id, employee_id),
  KEY ix_payroll_item_employee (employee_id),
  CONSTRAINT fk_payroll_item_period   FOREIGN KEY (period_id)   REFERENCES payroll_periods (id) ON DELETE CASCADE,
  CONSTRAINT fk_payroll_item_employee FOREIGN KEY (employee_id) REFERENCES employees       (id) ON DELETE CASCADE,
  CONSTRAINT fk_payroll_item_actor    FOREIGN KEY (calculated_by) REFERENCES app_users     (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20f. Rincian baris komponen hasil perhitungan (snapshot, aman bila master berubah)
CREATE TABLE IF NOT EXISTS payroll_item_lines (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id       BIGINT UNSIGNED NOT NULL,
  component_id  INT UNSIGNED  NULL,
  component_code VARCHAR(30)  NOT NULL,
  component_name VARCHAR(100) NOT NULL,
  type          ENUM('penghasilan','potongan','beban_perusahaan') NOT NULL,
  calc_method   VARCHAR(20)   NOT NULL DEFAULT 'tetap',
  base_amount   DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'dasar hitung (mis. gaji pokok)',
  percent       DECIMAL(7,4)  NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'hasil akhir',
  taxable       TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'snapshot: 1 = masuk dasar PPh',
  bpjs_base     TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'snapshot: 1 = masuk dasar iuran BPJS',
  detail        VARCHAR(255)  NULL COMMENT 'keterangan, mis. 22 hari hadir x 20.000',
  sort_order    INT           NOT NULL DEFAULT 100,
  PRIMARY KEY (id),
  KEY ix_payroll_line_item (item_id),
  CONSTRAINT fk_payroll_line_item      FOREIGN KEY (item_id)      REFERENCES payroll_items      (id) ON DELETE CASCADE,
  CONSTRAINT fk_payroll_line_component FOREIGN KEY (component_id) REFERENCES payroll_components (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20g. Riwayat perubahan payroll (audit khusus, tampil di halaman detail)
CREATE TABLE IF NOT EXISTS payroll_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_id   INT UNSIGNED  NULL,
  item_id     BIGINT UNSIGNED NULL,
  employee_id INT UNSIGNED  NULL,
  action      VARCHAR(40)   NOT NULL COMMENT 'period.create/item.calc/item.edit/period.approve/period.pay',
  detail      TEXT          NULL,
  actor_id    INT UNSIGNED  NULL,
  ip_address  VARCHAR(45)   NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_payroll_audit_period (period_id, created_at),
  KEY ix_payroll_audit_item (item_id, created_at),
  CONSTRAINT fk_payroll_audit_period   FOREIGN KEY (period_id)   REFERENCES payroll_periods (id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_audit_item     FOREIGN KEY (item_id)     REFERENCES payroll_items   (id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_audit_employee FOREIGN KEY (employee_id) REFERENCES employees       (id) ON DELETE SET NULL,
  CONSTRAINT fk_payroll_audit_actor    FOREIGN KEY (actor_id)    REFERENCES app_users       (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
DEALLOCATE PREPARE stmt;
