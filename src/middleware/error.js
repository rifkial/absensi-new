'use strict';

const config = require('../config');
const { AppError } = require('../utils/errors');

/** Handler error terpusat. Harus dipasang setelah semua route. */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const isApp = err instanceof AppError;
  const status = isApp ? err.status : err.status || err.statusCode || 500;

  // Log error 5xx dan error tak terduga supaya mudah ditelusuri.
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err);
  } else if (!config.isProduction) {
    console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);
  }

  const body = {
    ok: false,
    error: {
      message: isApp || status < 500 ? err.message : 'Terjadi kesalahan pada server.',
      status,
    },
  };

  // Rate limit / lockout: beri tahu klien berapa lama harus menunggu.
  if (status === 429 && isApp && err.retryAfter) {
    res.setHeader('Retry-After', String(err.retryAfter));
    body.error.retry_after = err.retryAfter;
  }

  if (isApp && err.details) body.error.details = err.details;
  if (!config.isProduction && status >= 500) body.error.stack = err.stack;

  res.status(status).json(body);
}

/** Handler 404 untuk route yang tidak dikenal. */
function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: { message: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan.`, status: 404 },
  });
}

/**
 * Handler error untuk body parser (JSON/XML/limit).
 * Tanpa ini, error dari body-parser jadi 500 dan informasinya hilang.
 */
function bodyParserErrorHandler(err, req, res, next) {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({
      ok: false,
      error: { message: 'Format body request tidak valid.', status: 400 },
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: { message: 'Ukuran data melebihi batas yang diizinkan.', status: 413 },
    });
  }
  next(err);
}

/** Lungkus route async agar error-nya diteruskan ke errorHandler. */
const wrap = require('../utils/errors').asyncHandler;

module.exports = { errorHandler, notFoundHandler, bodyParserErrorHandler, wrap };
