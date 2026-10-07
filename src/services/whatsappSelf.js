'use strict';

/**
 * WhatsApp nomor sendiri via whatsapp-web.js (scan QR sekali, sesi persisten).
 *
 * Berdampingan dengan gateway lama (Fonnte/Wablas): provider dipilih lewat
 * `whatsapp_provider` = 'gateway' | 'self'. Service ini hanya aktif bila
 * provider 'self'. Sesi login tersimpan di `storage/whatsapp-session`
 * (di-gitignore) sehingga scan QR cukup sekali sampai logout.
 */

const path = require('node:path');
const fs = require('node:fs');

const config = require('../config');
const settingsService = require('./settings');

let client = null;
let starting = null;
const state = {
  state: 'idle',
  qr: null,
  qrDataUrl: null,
  qrAt: 0,
  phone: null,
  lastError: null,
  updatedAt: Date.now(),
};

function setState(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
}

function sessionPath() {
  const p = config.whatsapp.selfSessionPath || 'storage/whatsapp-session';
  return path.isAbsolute(p) ? p : path.join(config.root, p);
}

function toBoolLoose(value) {
  if (value === true || value === 1) return true;
  return ['1', 'true', 'yes', 'on', 'ya'].includes(String(value ?? '').trim().toLowerCase());
}

function toIntLoose(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function currentConfig() {
  const stored = await settingsService.getStoredMap();
  const pick = (key, envValue, fallback = '') => {
    if (Object.prototype.hasOwnProperty.call(stored, key)) {
      const v = stored[key];
      return v === '' || v === null || v === undefined ? fallback : v;
    }
    if (envValue === undefined || envValue === null || envValue === '') return fallback;
    return envValue;
  };
  const rawProvider = pick('whatsapp_provider', config.whatsapp.provider, 'gateway');
  const provider = String(rawProvider || 'gateway').trim().toLowerCase() === 'self' ? 'self' : 'gateway';
  const enabled = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_enabled')
    ? toBoolLoose(stored.whatsapp_enabled)
    : Boolean(config.whatsapp.enabled);
  const autostart = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_self_autostart')
    ? toBoolLoose(stored.whatsapp_self_autostart)
    : Boolean(config.whatsapp.selfAutostart);
  const minDelayMs = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_self_min_delay_ms')
    ? toIntLoose(stored.whatsapp_self_min_delay_ms, 1000, 60000, 4000)
    : toIntLoose(config.whatsapp.selfMinDelayMs, 1000, 60000, 4000);
  const maxDelayRaw = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_self_max_delay_ms')
    ? toIntLoose(stored.whatsapp_self_max_delay_ms, 1000, 120000, 9000)
    : toIntLoose(config.whatsapp.selfMaxDelayMs, 1000, 120000, 9000);
  const maxDelayMs = Math.max(minDelayMs, maxDelayRaw);
  const perMinute = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_self_per_minute')
    ? toIntLoose(stored.whatsapp_self_per_minute, 1, 60, 12)
    : toIntLoose(config.whatsapp.selfPerMinute, 1, 60, 12);
  const dailyLimit = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_self_daily_limit')
    ? toIntLoose(stored.whatsapp_self_daily_limit, 10, 5000, 300)
    : toIntLoose(config.whatsapp.selfDailyLimit, 10, 5000, 300);
  return { provider, enabled, autostart, minDelayMs, maxDelayMs, perMinute, dailyLimit };
}

/**
 * Anti-banned: kirim berurutan (FIFO) + jeda acak + batas laju.
 *
 * WhatsApp memblokir nomor yang kirim massal serentak / pola robot kaku.
 * Semua kirim provider 'self' lewat satu antrean ini: satu pesan jalan,
 * pesan lain tunggu giliran, tiap kirim diberi jeda acak, plus batas
 * per menit dan per hari supaya pola kirim mirip manusia.
 */
const queue = [];
let draining = false;
let lastSentAt = 0;
const sentAtMinute = [];
let sentDayKey = null;
let sentDayCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min, max) => min + Math.floor(Math.random() * Math.max(0, max - min + 1));

function pruneMinuteMarks(now) {
  while (sentAtMinute.length > 0 && now - sentAtMinute[0] > 60000) sentAtMinute.shift();
}

function dayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function queueStats() {
  const now = Date.now();
  pruneMinuteMarks(now);
  const key = dayKey();
  return {
    queued: queue.length,
    draining,
    sentLastMinute: sentAtMinute.length,
    sentToday: sentDayKey === key ? sentDayCount : 0,
    lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null,
  };
}

function resetQueue() {
  queue.length = 0;
  draining = false;
  lastSentAt = 0;
  sentAtMinute.length = 0;
  sentDayKey = null;
  sentDayCount = 0;
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue[0];
      try {
        const cfg = await currentConfig();
        const now = Date.now();
        pruneMinuteMarks(now);
        const key = dayKey();
        if (sentDayKey !== key) {
          sentDayKey = key;
          sentDayCount = 0;
        }
        if (sentDayCount >= cfg.dailyLimit) {
          throw new Error(`Batas harian tercapai (${sentDayCount}/${cfg.dailyLimit}). Coba lagi besok.`);
        }
        if (sentAtMinute.length >= cfg.perMinute) {
          const waitMs = 60000 - (now - sentAtMinute[0]) + 500;
          await sleep(Math.max(1000, waitMs));
          continue;
        }
        const sinceLast = now - lastSentAt;
        const gap = randomDelay(cfg.minDelayMs, cfg.maxDelayMs);
        if (lastSentAt > 0 && sinceLast < gap) {
          await sleep(gap - sinceLast);
          continue;
        }
        const result = await sendNow(job.target, job.message);
        lastSentAt = Date.now();
        pruneMinuteMarks(lastSentAt);
        sentAtMinute.push(lastSentAt);
        sentDayCount += 1;
        queue.shift();
        job.resolve(result);
      } catch (err) {
        const failed = queue.shift();
        failed?.reject(err);
      }
    }
  } finally {
    draining = false;
  }
}

function enqueueSend(target, message) {
  return new Promise((resolve, reject) => {
    queue.push({ target, message, resolve, reject, enqueuedAt: Date.now() });
    drainQueue();
  });
}

function normalizeTarget(target) {
  let digits = String(target || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  if (!digits.startsWith('62')) return null;
  if (digits.length < 10 || digits.length > 15) return null;
  return `${digits}@c.us`;
}

function ensureClient() {
  if (client) return client;
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const dir = sessionPath();
  fs.mkdirSync(dir, { recursive: true });
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: dir }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', async (qr) => {
    setState({ state: 'qr', qr, qrDataUrl: null, qrAt: Date.now(), lastError: null });
    try {
      const QRCode = require('qrcode');
      const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
      if (state.qr === qr) setState({ qrDataUrl: dataUrl });
    } catch (err) {
      setState({ lastError: `Gagal membuat gambar QR: ${err.message}` });
    }
  });

  client.on('authenticated', () => {
    if (state.state === 'qr' || state.state === 'starting') setState({ state: 'starting', lastError: null });
  });

  client.on('ready', () => {
    let phone = null;
    try {
      phone = client?.info?.wid?.user ? String(client.info.wid.user) : null;
    } catch {
      phone = null;
    }
    setState({ state: 'ready', qr: null, qrDataUrl: null, phone, lastError: null });
  });

  client.on('auth_failure', (message) => {
    setState({ state: 'auth_failure', lastError: String(message || 'Autentikasi WhatsApp gagal.') });
  });

  client.on('disconnected', (reason) => {
    setState({ state: 'disconnected', qr: null, qrDataUrl: null, lastError: `Terputus: ${reason || 'unknown'}` });
  });

  return client;
}

async function start({ force = false } = {}) {
  const cfg = await currentConfig();
  if (!cfg.enabled) throw new Error('Aktifkan WhatsApp dulu di Pengaturan (centang Aktifkan WhatsApp, lalu Simpan).');
  if (cfg.provider !== 'self') throw new Error("Provider tersimpan masih 'Gateway'. Pilih 'Nomor sendiri (scan QR)' lalu klik Simpan Perubahan (butuh admin), baru klik Hubungkan.");
  if (client && state.state === 'ready' && !force) return status();
  if (starting && !force) return starting.then(() => status());
  setState({ state: 'starting', lastError: null });
  const c = ensureClient();
  starting = c.initialize().catch((err) => {
    setState({ state: 'error', lastError: err.message });
    throw err;
  }).finally(() => {
    starting = null;
  });
  await starting;
  return status();
}

async function stop() {
  starting = null;
  if (client) {
    try {
      await client.destroy();
    } catch {
      // abaikan
    }
    client = null;
  }
  if (state.state === 'ready' || state.state === 'starting' || state.state === 'qr') {
    setState({ state: 'stopped', qr: null, qrDataUrl: null });
  }
  return status();
}

async function logout() {
  starting = null;
  if (client) {
    try {
      await client.logout();
    } catch {
      // abaikan
    }
    try {
      await client.destroy();
    } catch {
      // abaikan
    }
    client = null;
  }
  try {
    fs.rmSync(sessionPath(), { recursive: true, force: true });
  } catch {
    // abaikan
  }
  setState({ state: 'idle', qr: null, qrDataUrl: null, qrAt: 0, phone: null, lastError: null });
  return status();
}

async function status() {
  const cfg = await currentConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    autostart: cfg.autostart,
    minDelayMs: cfg.minDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    perMinute: cfg.perMinute,
    dailyLimit: cfg.dailyLimit,
    state: state.state,
    ready: state.state === 'ready',
    qrDataUrl: state.qrDataUrl,
    qrAt: state.qrAt || null,
    phone: state.phone,
    lastError: state.lastError,
    updatedAt: new Date(state.updatedAt).toISOString(),
    queue: queueStats(),
  };
}

async function sendNow(target, message) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'Pesan kosong.' };
  const to = normalizeTarget(target);
  if (!to) return { ok: false, error: 'Nomor tujuan tidak valid. Pakai format 62812xxxxxxx.' };
  if (!client || state.state !== 'ready') {
    return { ok: false, error: 'WhatsApp nomor sendiri belum terhubung. Scan QR di Pengaturan dulu.' };
  }
  try {
    const result = await client.sendMessage(to, text);
    return { ok: true, messageId: result?.id?._serialized || null };
  } catch (err) {
    setState({ lastError: err.message });
    return { ok: false, error: err.message };
  }
}

/** Semua kirim lewat antrean anti-banned (FIFO + jeda + batas laju). */
async function send({ target, message }) {
  const cfg = await currentConfig();
  if (!cfg.enabled) return { ok: false, skipped: true, reason: 'WhatsApp tidak diaktifkan.' };
  if (cfg.provider !== 'self') return { ok: false, skipped: true, reason: "Provider bukan 'self'." };
  try {
    const result = await enqueueSend(target, message);
    if (result?.ok) result.queuedMs = undefined;
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Jalan saat server start bila provider self + autostart. Tanpa bikin boot gagal. */
async function maybeAutostart() {
  try {
    const cfg = await currentConfig();
    if (!cfg.enabled || cfg.provider !== 'self' || !cfg.autostart) return;
    start().catch((err) => {
      console.warn(`[whatsapp-self] Autostart gagal: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[whatsapp-self] Autostart dilewati: ${err.message}`);
  }
}

module.exports = {
  start,
  stop,
  logout,
  status,
  send,
  normalizeTarget,
  maybeAutostart,
  queueStats,
  resetQueue,
};
