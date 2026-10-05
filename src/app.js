'use strict';

const path = require('node:path');
const express = require('express');

const config = require('./config');
const { errorHandler, notFoundHandler, bodyParserErrorHandler } = require('./middleware/error');

const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const shiftRoutes = require('./routes/shifts');
const holidayRoutes = require('./routes/holidays');
const deviceRoutes = require('./routes/devices');
const attendanceRoutes = require('./routes/attendance');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const meRoutes = require('./routes/me');

/**
 * Aplikasi HTTP utama (port 3000).
 * Berisi UI statis + REST API.
 *
 * Server terpisah untuk protokol PUSH mesin ada di src/server.js
 * (port 3001) supaya mesin tidak perlu melewati proxy/rule yang sama.
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Machines and proxies sometimes send X-Forwarded-*; needed for correct client IP on PUSH.
  app.set('trust proxy', true);

  // Keamanan dasar. CSP sengaja longgar agar Chart.js dari CDN & font tetap jalan.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.use(express.json({ limit: config.server.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));
  app.use(bodyParserErrorHandler);

  // Health check - tidak butuh autentikasi agar bisa dipakai monitoring.
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: 'up',
      env: config.env,
      timezone: process.env.TZ,
      push_port: config.server.pushPort,
      uptime_seconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/employees', employeeRoutes);
  app.use('/api/shifts', shiftRoutes);
  app.use('/api/holidays', holidayRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/me', meRoutes);

  // Frontend
  const publicDir = path.isAbsolute(config.server.publicDir)
    ? config.server.publicDir
    : path.join(config.root, config.server.publicDir);

  app.use(express.static(publicDir, { extensions: ['html'], maxAge: config.isProduction ? '1h' : 0 }));

  // Fallback: ruta non-API dilayani index.html (untuk SPA sederhana).
  app.get(/^\/(?!api|health|iclock).*/, (req, res, next) => {
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
