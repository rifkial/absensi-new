'use strict';

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isBetween = require('dayjs/plugin/isBetween');
const isoWeek = require('dayjs/plugin/isoWeek');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);
dayjs.extend(isoWeek);
dayjs.extend(customParseFormat);

const config = require('../config');
const { AppError } = require('./errors');

const DATE = 'YYYY-MM-DD';
const DATETIME = 'YYYY-MM-DD HH:mm:ss';
const TIME = 'HH:mm';
const TIME_SEC = 'HH:mm:ss';

// Zona waktu aplikasi, dipakai dayjs.tz() saat parsing string dari mesin.
const TZ = process.env.TZ || config.timezone || 'Asia/Jakarta';

const dayjsTz = (...args) => dayjs(...args);

function now() {
  return dayjs();
}

function today() {
  return dayjs().format(DATE);
}

function formatDate(value, pattern = DATE) {
  if (!value) return null;
  const d = dayjs(value);
  return d.isValid() ? d.format(pattern) : null;
}

function formatTime(value, pattern = TIME) {
  if (!value) return null;
  const d = dayjs(value);
  return d.isValid() ? d.format(pattern) : null;
}

function formatDateTime(value, pattern = DATETIME) {
  if (!value) return null;
  const d = dayjs(value);
  return d.isValid() ? d.format(pattern) : null;
}

/**
 * Parse input yang bisa ber variously: 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm:ss',
 * 'DD/MM/YYYY HH:mm', 'YYYY/MM/DD', timestamp ms, atau Date.
 * Return dayjs atau null bila tidak bisa diparse.
 */
function parse(value) {
  if (value === null || value === undefined || value === '') return null;

  if (dayjs.isDayjs(value)) return value.isValid() ? value : null;
  if (value instanceof Date) return dayjs(value).isValid() ? dayjs(value) : null;

  if (typeof value === 'number') {
    // detik vs milidetik
    const ms = value < 1e11 ? value * 1000 : value;
    const d = dayjs(ms);
    return d.isValid() ? d : null;
  }

  const input = String(value).trim();

  const formats = [
    'YYYY-MM-DD HH:mm:ss.SSS',
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DD HH:mm',
    'YYYY-MM-DDTHH:mm:ss.SSS',
    'YYYY-MM-DDTHH:mm:ss',
    'YYYY-MM-DD',
    'DD/MM/YYYY HH:mm:ss',
    'DD/MM/YYYY HH:mm',
    'DD/MM/YYYY',
    'DD-MM-YYYY HH:mm:ss',
    'DD-MM-YYYY',
    'MM/DD/YYYY HH:mm:ss',
    'MM/DD/YYYY',
    'YYYY/MM/DD HH:mm:ss',
    'YYYY/MM/DD',
  ];

  for (const fmt of formats) {
    const d = dayjs(input, fmt, true);
    if (d.isValid()) return d;
  }

  // Tanggal panjang/free-form: beberapa jam mesin tidak zero-padded
  const loose = dayjs(input);
  return loose.isValid() ? loose : null;
}

/** Parse lalu formatkan ke DATETIME untuk disimpan ke MySQL. */
function toDateTime(value) {
  const d = parse(value);
  return d ? d.format(DATETIME) : null;
}

/** Parse lalu formatkan ke DATE (YYYY-MM-DD) untuk disimpan ke MySQL. */
function toDate(value) {
  const d = parse(value);
  return d ? d.format(DATE) : null;
}

/** Ubah "HH:mm"/"HH:mm:ss" -> menit sejak tengah malam. */
function timeToMinutes(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return value;

  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!match) return fallback;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

/** Ubah menit sejak tengah malam -> "HH:mm". */
function minutesToTime(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = String(Math.floor(total / 60)).padStart(2, '0');
  const m = String(total % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Padded time dari mesin: beberapa firmware mengirim " 9:5:3" alih-alih "09:05:03".
 * Lengkapi agar bisa di-parse dayjs.
 */
function normalizeMachineTime(value) {
  if (value === null || value === undefined) return null;
  let str = String(value).trim();
  if (str === '') return null;

  str = str.replace(/\//g, '-');

  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(str);
  if (match) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(match[1])}:${p(match[2])}:${p(match[3] ?? 0)}`;
  }

  const dateTime = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(str);
  if (dateTime) {
    const p = (n, len = 2) => String(n).padStart(len, '0');
    return `${p(dateTime[1], 4)}-${p(dateTime[2])}-${p(dateTime[3])} ${p(dateTime[4])}:${p(dateTime[5])}:${p(dateTime[6] ?? 0)}`;
  }

  return str;
}

/** Daftar hari dalam rentang [from, to] (inklusif), format YYYY-MM-DD. */
function dateRange(from, to) {
  const start = dayjs(toDate(from) ?? from);
  const end = dayjs(toDate(to) ?? to);
  if (!start.isValid() || !end.isValid()) return [];

  const out = [];
  let cursor = start.startOf('day');
  const last = end.startOf('day');
  // Pengaman: rentang dibatasi sekitar 3 tahun supaya tidak OOM bila input salah
  let guard = 0;
  while (cursor.isBefore(last) || cursor.isSame(last, 'day')) {
    out.push(cursor.format(DATE));
    cursor = cursor.add(1, 'day');
    if (++guard > 1100) break;
  }
  return out;
}

/** Selisih menit absolut antara dua nilai waktu (bisamelintasi hari). */
function diffMinutes(later, earlier) {
  const a = parse(later);
  const b = parse(earlier);
  if (!a || !b) return 0;
  return Math.round(a.diff(b, 'minute', true));
}

/** Tanggal dalam bahasa Indonesia, mis. "Senin, 30 September 2026". */
const HARI_INDO = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN_INDO = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const HARI_PENDEK = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];

function dayName(date, short = false) {
  const d = dayjs(toDate(date) ?? date);
  if (!d.isValid()) return '';
  return short ? HARI_PENDEK[d.day()] : HARI_INDO[d.day()];
}

function monthName(month, short = false) {
  const index = Number(month) - 1;
  if (index < 0 || index > 11) return '';
  return short ? BULAN_PENDEK[index] : BULAN_INDO[index];
}

function longDate(value) {
  const d = dayjs(toDate(value) ?? value);
  if (!d.isValid()) return '';
  return `${dayName(d)}, ${d.date()} ${monthName(d.month() + 1)} ${d.year()}`;
}

/** Nomor hari dalam ISO week (1=Senin..7=Minggu). */
function isoDayOfWeek(value) {
  const d = dayjs(toDate(value) ?? value);
  return d.isValid() ? d.isoWeekday() : 0;
}

/**
 * Nomor hari Minggu dalam isoWeekday (1=Senin ... 7=Minggu).
 *
 * Aplikasi ini memperlakukan Minggu sebagai hari NON-kerja secara mutlak:
 * tidak ada shift, pengaturan global, atau data lama yang bisa membuatnya
 * menjadi hari kerja. Alasannya, hitungan hari kerja dipakai untuk potong
 * jatah cuti dan persentase kehadiran; kalau Minggu ikut terhitung, karyawan
 * dirugikan tanpa diminta.
 */
const SUNDAY_ISO = 7;

/**
 * Deret hari kerja (1..7) dari string "1,2,3,4,5".
 * Nilai di luar rentang dibuang, dan 7 (Minggu) ikut dibuang karena hari
 * Minggu tidak pernah dihitung sebagai hari kerja.
 */
function parseWorkDays(value) {
  const list = Array.isArray(value)
    ? value.map(Number)
    : typeof value === 'string' && value.trim() !== ''
      ? value.split(/[,\s;]+/).map((part) => Number(part.trim()))
      : [];

  return list.filter((n) => Number.isInteger(n) && n >= 1 && n <= SUNDAY_ISO - 1);
}

/** Nama hari dalam format isoWeekday: 1 = Senin ... 7 = Minggu. */
const ISO_DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

/**
 * Parse work_days dengan validasi ketat.
 *
 * Berbeda dengan parseWorkDays (yang diam-diam membuang nilai tak valid),
 * fungsi ini melempar error bila ada angka di luar 1-6. Ini penting karena
 * UI versi lama mengirim indeks 0-6 sehingga hari Minggu terkirim sebagai "0"
 * dan hilang begitu saja tanpa ada pesan error.
 *
 * Angka 7 (Minggu) ditolak secara eksplisit, bukan diam-diam dibuang, supaya
 * admin yang sengaja mencentang Minggu tahu kalau itu tidak berlaku.
 *
 * @param {string|number[]} value
 * @param {{ label?: string }} [options]
 * @returns {number[]} daftar hari unik, terurut
 */
function parseWorkDaysStrict(value, { label = 'work_days' } = {}) {
  const raw = Array.isArray(value) ? value.map((v) => String(v).trim()) : String(value ?? '').split(/[,\s;]+/);
  const parts = raw.map((part) => part.trim()).filter((part) => part !== '');

  if (parts.length === 0) {
    throw new AppError(`${label} wajib diisi. Pilih minimal satu hari kerja.`, 400);
  }

  const days = [];
  for (const part of parts) {
    if (!/^-?\d+$/.test(part)) {
      throw new AppError(
        `${label} hanya boleh berisi angka 1-6 (1=Senin ... 6=Sabtu). Nilai "${part}" tidak valid.`,
        400
      );
    }
    const day = Number(part);
    if (day === SUNDAY_ISO) {
      throw new AppError(
        'Hari Minggu tidak bisa dipilih sebagai hari kerja. Pilih hari lain.',
        400
      );
    }
    if (day < 1 || day > SUNDAY_ISO - 1) {
      throw new AppError(
        `${label} hanya boleh berisi angka 1-6 (1=Senin ... 6=Sabtu). ` +
          `Nilai "${part}" di luar rentang.`
      );
    }
    days.push(day);
  }

  if (days.length === 0) {
    throw new AppError(`${label} wajib diisi. Pilih minimal satu hari kerja selain Minggu.`, 400);
  }

  return [...new Set(days)].sort((a, b) => a - b);
}

/** Ringkas daftar hari (1..7) menjadi label "Senin, Rabu, Jumat". */
function workDaysLabel(value, { short = false } = {}) {
  const days = parseWorkDays(value);
  if (days.length === 0) return '';
  const names = days.map((day) => {
    const name = ISO_DAY_NAMES[day - 1] || '?';
    return short ? name.slice(0, 3) : name;
  });
  return names.join(', ');
}

/**
 * Apakah `date` termasuk hari kerja.
 *
 * Ini satu-satunya titik keputusan yang dipakai seluruh aplikasi (rekap harian
 * dan pemotong jatah cuti), jadi aturan Minggu diletakkan di sini:
 *   - tanggal Minggu SELALU bukan hari kerja, apa pun isi work_days
 *   - work_days kosong/Tidak dikenal => semua hari selain Minggu dianggap kerja
 *
 * Pengecekan Minggu dilakukan sebelum work_days dibaca supaya shift yang
 * hanya berisi "7" pun tidak membuat Minggu terbaca sebagai hari kerja.
 */
function isWorkDay(workDays, date) {
  if (isoDayOfWeek(date) === SUNDAY_ISO) return false;

  const days = parseWorkDays(workDays);
  if (days.length === 0) return true;

  return days.includes(isoDayOfWeek(date));
}

function addDays(value, amount) {
  const d = dayjs(toDate(value) ?? value);
  return d.isValid() ? d.add(amount, 'day').format(DATE) : null;
}

function startOfMonth(value = today()) {
  return dayjs(toDate(value) ?? value).startOf('month').format(DATE);
}

function endOfMonth(value = today()) {
  return dayjs(toDate(value) ?? value).endOf('month').format(DATE);
}

/** Gabungkan tanggal + "HH:mm" menjadi datetime. */
function combineDateTime(date, time) {
  const d = dayjs(toDate(date) ?? date);
  if (!d.isValid()) return null;
  const t = normalizeMachineTime(time);
  if (!t) return null;
  return dayjs(`${d.format(DATE)} ${t}`).format(DATETIME);
}

/** Bentuk postgres/mysql DATETIME yang aman (tidak ada karakter aneh). */
function safeDateTime(value) {
  const d = parse(value);
  return d && d.isValid() ? d.format(DATETIME) : null;
}

module.exports = {
  dayjs,
  TZ,
  DATE,
  DATETIME,
  TIME,
  TIME_SEC,
  now,
  today,
  parse,
  parseWorkDays,
  parseWorkDaysStrict,
  workDaysLabel,
  ISO_DAY_NAMES,
  SUNDAY_ISO,
  isWorkDay,
  isoDayOfWeek,
  formatDate,
  formatTime,
  formatDateTime,
  toDate,
  toDateTime,
  safeDateTime,
  timeToMinutes,
  minutesToTime,
  normalizeMachineTime,
  dateRange,
  diffMinutes,
  dayName,
  monthName,
  longDate,
  addDays,
  startOfMonth,
  endOfMonth,
  combineDateTime,
  HARI_INDO,
  BULAN_INDO,
};
