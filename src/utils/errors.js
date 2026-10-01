'use strict';

const config = require('../config');

/** Error yang punya HTTP status code, dilempar dari service lalu ditangkap middleware. */
class AppError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(message, 400, details);
const unauthorized = (message = 'Anda harus masuk terlebih dahulu.') => new AppError(message, 401);
const forbidden = (message = 'Anda tidak punya izin untuk aksi ini.') => new AppError(message, 403);
const notFound = (message = 'Data tidak ditemukan.') => new AppError(message, 404);
const conflict = (message, details) => new AppError(message, 409, details);

/** Bungkus handler async supaya error-nya sampai ke error middleware. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Batasi nilai angka. */
function clamp(value, min, max, fallback = min) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

/** Ambil angka dalam rentang tertentu dari query string. */
function intParam(value, min, max, fallback) {
  return clamp(value, min, max, fallback);
}

/**
 * Ambil nilai string dari body, bersihkan spasi, batasi panjang.
 */
function str(value, { maxLength = 255, trim = true } = {}) {
  if (value === null || value === undefined) return null;
  const out = String(value);
  return (trim ? out.trim() : out).slice(0, maxLength);
}

/** Ubah "1"/"true"/"yes"/"on" menjadi boolean, selain itu null. */
function boolParam(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return ['1', 'true', 'yes', 'on', 'ya'].includes(String(value).toLowerCase());
}

/** Daftar nilai yang valid, atau null bila kosong/tidak dikirim. */
function enumParam(value, allowed) {
  if (value === null || value === undefined || value === '') return null;
  const out = String(value).trim();
  return allowed.includes(out) ? out : null;
}

/** Normalisasi halaman untuk query list. */
function pagination(query) {
  const page = intParam(query.page, 1, 100000, 1);
  const perPage = intParam(query.per_page ?? query.perPage ?? query.limit, 1, 500, 25);
  return { page, perPage, offset: (page - 1) * perPage };
}

function pageMeta(total, { page, perPage }) {
  return {
    total: Number(total || 0),
    page,
    per_page: perPage,
    total_pages: perPage > 0 ? Math.ceil(Number(total || 0) / perPage) : 0,
  };
}

/** Validasi konfigurasi produksi sebelum server dinyatakan siap. */
function assertProductionReady() {
  if (!config.isProduction) return [];
  const warnings = [];
  if (config.insecureSecret) warnings.push('JWT_SECRET belum diganti.');
  if (!config.mail.enabled && !config.whatsapp.enabled) {
    warnings.push('Tidak ada channel notifikasi aktif (MAIL_ENABLED / WHATSAPP_ENABLED).');
  }
  return warnings;
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  asyncHandler,
  clamp,
  intParam,
  str,
  boolParam,
  enumParam,
  pagination,
  pageMeta,
  assertProductionReady,
};
