'use strict';

const config = require('./config');
const db = require('./db/pool');
const { createApp } = require('./app');
const { createPushRouter } = require('./devices/pushhttp/adapter');
const sync = require('./services/sync');
const realtime = require('./services/realtime');
const { assertProductionReady } = require('./utils/errors');

/**
 * Titik masuk server.
 *
 * Dua listener HTTP:
 *   - port 3000 : UI + REST API
 *   - port 3001 : protokol PUSH/ADMS untuk mesin fingerprint
 *
 * Keduanya bisa dimatikan lewat .env (PUSH_PORT dikosongkan tidak didukung,
 * tapi tetap bisa dibuat sama dengan port utama bila diinginkan).
 */

let mainServer = null;
let pushServer = null;
let shuttingDown = false;

async function start() {
  console.log('='.repeat(64));
  console.log('  APLIKASI ABSENSI FINGERPRINT');
  console.log('='.repeat(64));
  console.log(`  Mode      : ${config.env}`);
  console.log(`  Zona waktu: ${process.env.TZ}`);
  console.log(`  Database  : mysql://${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);

  // 1) Pastikan database hidup sebelum server menerima request.
  try {
    const info = await db.testConnection();
    console.log(`  DB siap   : ${info.version} (server time ${info.now})`);
  } catch (err) {
    console.error('\n[ERROR] Tidak bisa terhubung ke database.');
    console.error(`  Pastikan MySQL/MariaDB di XAMPP sudah dijalankan dan kredensial .env benar.`);
    console.error(`  Detail   : ${err.message}\n`);
    process.exit(1);
  }

  // 2) Peringatan konfigurasi produksi.
  const warnings = assertProductionReady();
  for (const warning of warnings) console.warn(`  [PERINGATAN] ${warning}`);
  if (!config.isProduction && config.insecureSecret) {
    console.warn('  [PERINGATAN] JWT_SECRET masih nilai contoh - WAJIB diganti sebelum dipakai di jaringan publik.');
  }

  // Peringatan bila akun admin masih memakai password bawaan dari seed.
  await warnIfDefaultAdminPassword();

  // 3) Server utama (UI + API).
  const app = createApp();
  mainServer = app.listen(config.server.port, config.server.host, () => {
    console.log(`  Web       : http://localhost:${config.server.port}`);
  });
  // Request gantung (mesin timeout / DB macet) jangan pegang koneksi selamanya:
  // bunuh socket-nya supaya browser retry, bukan spinner abadi.
  mainServer.requestTimeout = 30000;
  mainServer.headersTimeout = 35000;
  mainServer.keepAliveTimeout = 5000;
  // Lacak koneksi terbuka (SSE/EventSource) supaya shutdown tidak gantung.
  trackConnections(mainServer);
  mainServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Port ${config.server.port} sudah dipakai proses lain.`);
      console.error('  Ubah PORT di file .env lalu jalankan ulang.\n');
      process.exit(1);
    }
    throw err;
  });

  // 4) Server PUSH untuk mesin fingerprint.
  startPushServer();

  // 5) Penjadwal sinkronisasi otomatis (MATI default via SYNC_ENABLED=false).
  if (config.device.syncEnabled) {
    sync.startScheduler({ intervalMinutes: config.device.syncIntervalMinutes });
  } else {
    console.log('  [scheduler] Auto-sync MATI (SYNC_ENABLED=false). Sinkron manual via tombol UI.');
  }

  console.log('='.repeat(64));
  console.log('  Server siap.');
  // Kredensial tidak dicetak di sini. Password awal hanya ditampilkan sekali
  // saat akun admin pertama dibuat oleh `npm run seed`.
  console.log('='.repeat(64));
}

/**
 * Peringatan bila akun admin masih memakai password bawaan hasil seed.
 *
 * Passwordnya sendiri tidak pernah dicetak; yang ditampilkan hanya peringatan
 * agar admin segera menggantinya lewat menu Pengguna.
 */
async function warnIfDefaultAdminPassword() {
  // Password sama persis dengan yang dipakai src/db/seed.js.
  const SEED_DEFAULT = 'admin123';

  try {
    const row = await db.queryOne(
      'SELECT password_hash FROM app_users WHERE username = ? AND is_active = 1',
      ['admin']
    );
    if (!row) return;

    const stillDefault = await require('bcryptjs').compare(SEED_DEFAULT, row.password_hash);
    if (stillDefault) {
      console.warn('  [PERINGATAN] Akun "admin" masih memakai password bawaan seed.');
      console.warn('             Ganti lewat menu Pengguna sebelum dipakai di jaringan publik.');
    }
  } catch (err) {
    // Pemeriksaan ini hanya gravy; kegagalan tidak boleh menghalangi start.
    console.warn(`  [PERINGATAN] Gagal memeriksa password admin: ${err.message}`);
  }
}

function startPushServer() {
  if (config.server.pushPort === config.server.port) {
    console.log(`  PUSH      : digabung ke port utama (${config.server.port})`);
    return;
  }

  const express = require('express');
  const pushApp = express();
  pushApp.disable('x-powered-by');
  pushApp.set('trust proxy', true);
  pushApp.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  pushApp.use(createPushRouter());

  pushServer = pushApp.listen(config.server.pushPort, config.server.host, () => {
    const hint = require('./devices/pushhttp/adapter').getLocalAddressHint();
    console.log(`  PUSH      : port ${config.server.pushPort} (isi IP ${hint} di menu ADMS mesin)`);
  });
  trackConnections(pushServer);

  pushServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`\n  [PERINGATAN] Port PUSH ${config.server.pushPort} sudah dipakai.`);
      console.warn('  Mesin dalam mode PUSH tidak akan bisa terhubung. Ubah PUSH_PORT di .env.\n');
    } else {
      console.error('[PUSH] Error server:', err.message);
    }
  });
}

/** Lacak socket terbuka supaya shutdown bisa menghancurkan sisa koneksi. */
const openSockets = new Set();

function trackConnections(server) {
  if (!server) return;
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
}

/**
 * Tutup server tanpa gantung: SSE/EventSource keep-alive bikin
 * server.close() menunggu selamanya, jadi hancurkan sisa socket
 * setelah server berhenti menerima koneksi baru.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    setTimeout(() => {
      for (const socket of openSockets) {
        try {
          socket.destroy();
        } catch {
          // abaikan
        }
      }
      resolve();
    }, 1500).unref?.();
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[M${signal}] Menutup server...`);
  sync.stopScheduler();
  realtime.closeAll();

  // Pengaman: paksa keluar bila shutdown macet (mis. pool DB menggantung).
  setTimeout(() => {
    console.error('[shutdown] Paksa keluar setelah 8 detik.');
    process.exit(1);
  }, 8000).unref?.();

  await closeServer(mainServer);
  await closeServer(pushServer);
  await db.closePool().catch(() => {});

  console.log('[shutdown] Selesai.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  shutdown('uncaughtException');
});

start().catch((err) => {
  console.error('[fatal] Gagal menjalankan server:', err);
  process.exit(1);
});
