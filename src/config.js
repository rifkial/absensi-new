'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

// Zona waktu harus diset SEBELUM tanggal diakses, karena dayjs membaca TZ sekali
// di awal proses.
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

function str(key, fallback = undefined) {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value;
}

function int(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function bool(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Ubah "HH:mm" atau "HH:mm:ss" menjadi jumlah menit sejak tengah malam. */
function timeToMinutes(value, fallback = 0) {
  if (typeof value !== 'string') return fallback;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

const nodeEnv = str('NODE_ENV', 'development');
const isProduction = nodeEnv === 'production';

// Deteksi secret Development: di produksi ini harus ditolak karena akun admin
// yang di-seed memakai password default dan JWT bisa dipalsukan.
const INSECURE_SECRETS = new Set([
  '',
  'secret',
  'ganti-dengan-string-acak-minimal-32-karakter-panjang-sekarang',
  'dev-secret-ini-hanya-untuk-lokal-ganti-sebelum-produksi-000',
]);

const jwtSecret = str('JWT_SECRET', 'dev-secret-ini-hanya-untuk-lokal-ganti-sebelum-produksi-000');

const config = {
  root: ROOT,
  env: nodeEnv,
  isProduction,
  insecureSecret: INSECURE_SECRETS.has(jwtSecret) || jwtSecret.length < 32,

  server: {
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    publicDir: str('PUBLIC_DIR', 'public'),
    pushPort: int('PUSH_PORT', 3001),
    // Di produksi server harus menerima koneksi mesin PUSH dari luar (port berbeda)
    bodyLimit: '25mb',
  },

  db: {
    host: str('DB_HOST', '127.0.0.1'),
    port: int('DB_PORT', 3306),
    user: str('DB_USER', 'root'),
    password: str('DB_PASSWORD', ''),
    database: str('DB_NAME', 'absensi'),
    connectionLimit: int('DB_CONNECTION_LIMIT', 20),
    charset: 'utf8mb4_unicode_ci',
  },

  auth: {
    jwtSecret,
    jwtExpiresIn: str('JWT_EXPIRES_IN', '8h'),
    bcryptRounds: int('BCRYPT_ROUNDS', 10),
  },

  attendance: {
    cutoffTime: str('ATTENDANCE_CUTOFF_TIME', '23:59:59'),
    defaultLateTolerance: int('DEFAULT_LATE_TOLERANCE', 10),
    maxDailyWorkMinutes: int('MAX_DAILY_WORK_MINUTES', 600),
    backfillDays: int('BACKFILL_DAYS', 30),
  },

  device: {
    syncEnabled: bool('SYNC_ENABLED', false),
    syncIntervalMinutes: int('SYNC_INTERVAL_MINUTES', 5),
    timeoutMs: int('DEVICE_TIMEOUT_MS', 20000),
    clearLogAfterSync: bool('DEVICE_CLEAR_LOG_AFTER_SYNC', false),
    pushAuthToken: str('PUSH_AUTH_TOKEN', ''),
  },

  mail: {
    enabled: bool('MAIL_ENABLED', false),
    host: str('MAIL_HOST', 'smtp.gmail.com'),
    port: int('MAIL_PORT', 587),
    secure: bool('MAIL_SECURE', false),
    user: str('MAIL_USER', ''),
    pass: str('MAIL_PASS', ''),
    from: str('MAIL_FROM', 'Aplikasi Absensi <absensi@contoh.com>'),
  },

  whatsapp: {
    enabled: bool('WHATSAPP_ENABLED', false),
    provider: str('WHATSAPP_PROVIDER', 'gateway'),
    url: str('WHATSAPP_URL', ''),
    token: str('WHATSAPP_TOKEN', ''),
    target: str('WHATSAPP_TARGET', ''),
    targetField: str('WHATSAPP_FIELD_TARGET', 'target'),
    messageField: str('WHATSAPP_FIELD_MESSAGE', 'message'),
    selfSessionPath: str('WHATSAPP_SELF_SESSION', 'storage/whatsapp-session'),
    selfAutostart: bool('WHATSAPP_SELF_AUTOSTART', true),
    selfMinDelayMs: int('WHATSAPP_SELF_MIN_DELAY_MS', 4000),
    selfMaxDelayMs: int('WHATSAPP_SELF_MAX_DELAY_MS', 9000),
    selfPerMinute: int('WHATSAPP_SELF_PER_MINUTE', 12),
    selfDailyLimit: int('WHATSAPP_SELF_DAILY_LIMIT', 300),
  },
};

config.attendance.cutoffMinutes = timeToMinutes(config.attendance.cutoffTime, 23 * 60 + 59);

// Fail-fast: konfigurasi setengah jadi jauh lebih sulit didiagnosis saat runtime.
const problems = [];
if (config.isProduction && config.insecureSecret) {
  problems.push('JWT_SECRET masih memakai nilai contoh / terlalu pendek. Set nilai acak >= 32 karakter.');
}
if (!fs.existsSync(path.join(ROOT, '.env'))) {
  problems.push('File .env tidak ditemukan. Salin .env.example menjadi .env lalu sesuaikan.');
}
if (config.attendance.defaultLateTolerance < 0) {
  problems.push('DEFAULT_LATE_TOLERANCE tidak boleh negatif.');
}

if (problems.length > 0) {
  // Di development hanya peringatan, di produksi berhenti sebelum server menyala.
  if (config.isProduction) {
    throw new Error(`Konfigurasi tidak valid:\n - ${problems.join('\n - ')}`);
  }
  console.warn('[config] PERINGATAN:\n - ' + problems.join('\n - '));
}

module.exports = config;
