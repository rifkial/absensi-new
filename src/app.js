'use strict';

const path = require('node:path');
const express = require('express');

const config = require('./config');
const { errorHandler, notFoundHandler, bodyParserErrorHandler } = require('./middleware/error');

const auth = require('./middleware/auth');
const { wrap } = require('./middleware/error');
const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const shiftRoutes = require('./routes/shifts');
const holidayRoutes = require('./routes/holidays');
const deviceRoutes = require('./routes/devices');
const attendanceRoutes = require('./routes/attendance');
const reportRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const notificationRoutes = require('./routes/notifications');
const whatsappRoutes = require('./routes/whatsapp');
const backupRoutes = require('./routes/backup');
const meRoutes = require('./routes/me');
const masterRoutes = require('./routes/master');

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
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
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

  // Proksi tile OSM: browser panggil server lokal, server teruskan ke
  // tile.openstreetmap.org dengan header policy benar. Tanpa key.
  app.get(
    '/api/geo/tiles/:z/:x/:y.png',
    auth.requireAuth,
    wrap(async (req, res) => {
      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0 && n < 1 << 20) || z > 19) {
        return res.status(400).json({ ok: false, error: { message: 'koordinat tile tidak valid.' } });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'absensi-fingerprint/1.0 (dinas-checkin)',
            Referer: 'https://tile.openstreetmap.org/',
          },
        });
        if (!r.ok) return res.status(r.status).end();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const buf = Buffer.from(await r.arrayBuffer());
        res.send(buf);
      } catch {
        res.status(502).end();
      } finally {
        clearTimeout(timer);
      }
    })
  );

  // Proksi geocode: browser panggil server (tanpa key), server teruskan ke
  // Photon dengan User-Agent + Referer sesuai policy. Photon tanpa key.
  app.get(
    '/api/geo/search',
    auth.requireAuth,
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim().slice(0, 120);
      if (!q) return res.json({ ok: true, data: [] });
      const url = `https://photon.komoot.io/api/?limit=5&lang=en&q=${encodeURIComponent(q)}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': 'absensi-fingerprint/1.0 (dinas-checkin)',
            Referer: 'https://tile.openstreetmap.org/',
          },
        });
        if (!r.ok) throw new Error(`geocode ${r.status}`);
        const body = await r.json();
        const rows = (body && body.features ? body.features : [])
          .map((f) => {
            const c = f && f.geometry && f.geometry.coordinates;
            const p = f ? f.properties : {};
            if (!c || c.length < 2) return null;
            return {
              lat: Number(c[1]),
              lng: Number(c[0]),
              label: [p.name, p.city || p.county, p.state, p.country].filter(Boolean).join(', '),
            };
          })
          .filter(Boolean);
        res.json({ ok: true, data: rows });
      } catch (err) {
        res.json({ ok: true, data: [], warning: `pencarian gagal: ${err.message}` });
      } finally {
        clearTimeout(timer);
      }
    })
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/employees', employeeRoutes);
  app.use('/api/shifts', shiftRoutes);
  app.use('/api/holidays', holidayRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  app.use('/api/backup', backupRoutes);
  app.use('/api/me', meRoutes);
  app.use('/api/master', masterRoutes);

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
