'use strict';

const db = require('../db/pool');
const { badRequest, boolParam, intParam, str } = require('../utils/errors');

/**
 * Pengaturan aplikasi yang disimpan di tabel `settings` (key-value).
 *
 * Nilai di sini dipakai sebagai runtime override atas nilai yang ada di .env,
 * sehingga admin bisa mengubah jam kerja global lewat UI tanpa menyentuh
 * berkas konfigurasi di server.
 */

const DEFAULTS = {
  // umum
  app_name: 'Aplikasi Absensi Fingerprint',
  company_name: 'PT Contoh Sejahtera',
  timezone: 'Asia/Jakarta',
  late_reminder_time: '09:00',
  daily_notify_time: '18:00',
  monthly_report_day: '1',

  // absensi
  attendance_cutoff_time: '23:59:59',
  default_late_tolerance: '10',
  max_daily_work_minutes: '600',
  backfill_days: '30',

  // jam kerja global (fallback bila karyawan tidak punya shift)
  use_global_when_no_shift: 'true',
  global_check_in: '08:00',
  global_check_out: '17:00',
  global_late_tolerance: '10',
  global_break_start: '',
  global_break_end: '',

  // perangkat
  sync_interval_minutes: '5',
  device_timeout_ms: '20000',
  device_clear_log_after_sync: 'false',
  push_port: '3001',
  push_auth_token: '',

  // email
  mail_enabled: 'false',
  mail_host: 'smtp.gmail.com',
  mail_port: '587',
  mail_secure: 'false',
  mail_user: '',
  mail_pass: '',
  mail_from: 'Aplikasi Absensi <absensi@contoh.com>',

  // whatsapp
  whatsapp_enabled: 'false',
  whatsapp_url: '',
  whatsapp_token: '',
  whatsapp_target: '',
  whatsapp_field_target: 'target',
  whatsapp_field_message: 'message',
};

/** Kapasitas cache supaya rekap harian tidak query `settings` berkali-kali. */
let cache = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;

function toText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isTime(value, withSeconds = false) {
  const pattern = withSeconds ? /^\d{1,2}:\d{2}(:\d{2})?$/ : /^\d{1,2}:\d{2}$/;
  return pattern.test(String(value || '').trim());
}

/** Ubah "HH:MM" -> "HH:MM:00" supaya konsisten dengan kolom TIME MySQL. */
function toDbTime(value) {
  const v = String(value || '').trim();
  if (!isTime(v)) return null;
  return v.length === 5 ? `${v}:00` : v;
}

/**
 * Ambil semua pengaturan. Nilai dari DB menang atas DEFAULTS, dan key yang
 * tidak dikenal tetap diteruskan supaya pengaturan tambahan tidak hilang.
 */
async function getAll({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cacheStamp < CACHE_TTL_MS) return cache;

  const rows = await db.queryAll('SELECT setting_key, setting_value FROM settings');
  const map = { ...DEFAULTS };

  for (const row of rows) {
    if (!row.setting_key) continue;
    map[row.setting_key] = toText(row.setting_value);
  }

  cache = map;
  cacheStamp = Date.now();
  return map;
}

function invalidateCache() {
  cache = null;
  cacheStamp = 0;
}

/** Ubah nilai string menjadi boolean dengan fallback. */
function boolSetting(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on', 'ya'].includes(String(value).trim().toLowerCase());
}

function intSetting(value, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Bersihkan nilai time; kembalikan string apa adanya kalau tidak valid. */
function timeSetting(value, fallback) {
  return isTime(value) ? String(value).trim() : fallback;
}

/** Bersihkan nilai boolean menjadi string 'true'/'false'. */
function boolText(value, fallback) {
  const b = boolParam(value);
  if (b === null) return fallback;
  return b ? 'true' : 'false';
}

/**
 * Validasi & normalisasi payload pengaturan.
 * Key yang tidak dikirim tidak ikut berubah (partial update).
 */
function normalize(payload = {}) {
  const out = {};

  const text = (key, maxLength, fallback = '') => {
    if (payload[key] === undefined) return;
    out[key] = str(payload[key], { maxLength }) || fallback;
  };
  const intText = (key, min, max, fallback) => {
    if (payload[key] === undefined) return;
    out[key] = String(intParam(payload[key], min, max, intSetting(DEFAULTS[key], fallback)));
  };
  const timeText = (key, withSeconds = false) => {
    if (payload[key] === undefined) return;
    out[key] = isTime(payload[key], withSeconds) ? String(payload[key]).trim() : DEFAULTS[key];
  };
  const boolKey = (key) => {
    if (payload[key] === undefined) return;
    out[key] = boolText(payload[key], DEFAULTS[key]);
  };
  const optionalTime = (key) => {
    if (payload[key] === undefined) return;
    out[key] = isTime(payload[key]) ? String(payload[key]).trim() : '';
  };

  // umum
  text('app_name', 120, DEFAULTS.app_name);
  text('company_name', 120, DEFAULTS.company_name);
  text('timezone', 60, DEFAULTS.timezone);
  timeText('late_reminder_time');
  timeText('daily_notify_time');
  intText('monthly_report_day', 1, 31, 1);

  // absensi
  timeText('attendance_cutoff_time', true);
  intText('default_late_tolerance', 0, 240, 10);
  intText('max_daily_work_minutes', 0, 1440, 600);
  intText('backfill_days', 0, 365, 30);

  // jam kerja global
  boolKey('use_global_when_no_shift');
  timeText('global_check_in');
  timeText('global_check_out');
  intText('global_late_tolerance', 0, 240, 10);
  optionalTime('global_break_start');
  optionalTime('global_break_end');

  // perangkat
  intText('sync_interval_minutes', 1, 1440, 5);
  intText('device_timeout_ms', 1000, 120000, 20000);
  boolKey('device_clear_log_after_sync');
  intText('push_port', 1, 65535, 3001);
  text('push_auth_token', 200);

  // email
  boolKey('mail_enabled');
  text('mail_host', 120, DEFAULTS.mail_host);
  intText('mail_port', 1, 65535, 587);
  boolKey('mail_secure');
  text('mail_user', 120);
  text('mail_pass', 200);
  text('mail_from', 160, DEFAULTS.mail_from);

  // whatsapp
  boolKey('whatsapp_enabled');
  text('whatsapp_url', 255);
  text('whatsapp_token', 255);
  text('whatsapp_target', 120);
  text('whatsapp_field_target', 60, DEFAULTS.whatsapp_field_target);
  text('whatsapp_field_message', 60, DEFAULTS.whatsapp_field_message);

  // Jaga-jaga: cek in < cek out kecuali shift lintas malam yang diizinkan.
  if (out.global_check_in && out.global_check_out) {
    const inMin = toMinutes(out.global_check_in);
    const outMin = toMinutes(out.global_check_out);
    // Sama saja tetap tidak berguna (bukan shift 24 jam).
    if (inMin !== null && outMin !== null && inMin === outMin) {
      throw badRequest('Jam masuk global dan jam pulang global tidak boleh sama.');
    }
  }

  if (out.global_break_start !== undefined || out.global_break_end !== undefined) {
    const current = cache || DEFAULTS;
    const bs = out.global_break_start !== undefined ? out.global_break_start : current.global_break_start;
    const be = out.global_break_end !== undefined ? out.global_break_end : current.global_break_end;
    if ((bs && !be) || (!bs && be)) {
      throw badRequest('Jam istirahat global mulai dan selesai harus diisi berdua atau kosong berdua.');
    }
  }

  return out;
}

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Simpan banyak pengaturan sekaligus (upsert per key). */
async function updateMany(payload = {}) {
  const data = normalize(payload);
  if (Object.keys(data).length === 0) throw badRequest('Tidak ada pengaturan yang diubah.');

  await db.transaction(async (conn) => {
    for (const [key, value] of Object.entries(data)) {
      await conn.execute(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ' +
          'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, value]
      );
    }
  });

  invalidateCache();
  return getAll({ refresh: true });
}

/**
 * Bangun objek shift tiruan dari pengaturan jam kerja global.
 * Bentuknya dibuat sama dengan baris tabel `shifts` supaya seluruh helper
 * (toleransi, durasi, jam istirahat) bisa dipakai tanpa perubahan.
 */
function globalShiftFrom(settings = {}) {
  if (!boolSetting(settings.use_global_when_no_shift, true)) return null;

  const checkIn = toDbTime(settings.global_check_in);
  const checkOut = toDbTime(settings.global_check_out);
  if (!checkIn || !checkOut) return null;

  const breakStart = toDbTime(settings.global_break_start);
  const breakEnd = toDbTime(settings.global_break_end);

  const startMin = toMinutes(checkIn);
  const endMin = toMinutes(checkOut);

  return {
    id: null,
    code: 'GLOBAL',
    name: 'Jam Kerja Global',
    start_time: checkIn,
    end_time: checkOut,
    break_start: breakStart && breakEnd ? breakStart : null,
    break_end: breakStart && breakEnd ? breakEnd : null,
    late_tolerance_min: intSetting(
      settings.global_late_tolerance,
      intSetting(settings.default_late_tolerance, 10)
    ),
    max_work_minutes: intSetting(settings.max_daily_work_minutes, 600),
    // 1..7 = Senin..Minggu (format isoWeekday, sama seperti kolom shifts.work_days).
    work_days: '1,2,3,4,5,6,7',
    half_day: 0,
    is_active: 1,
    is_global: 1,
  };
}

module.exports = {
  DEFAULTS,
  getAll,
  updateMany,
  normalize,
  invalidateCache,
  boolSetting,
  intSetting,
  timeSetting,
  globalShiftFrom,
};