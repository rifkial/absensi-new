'use strict';

/**
 * Konfigurasi kanal notifikasi (email & WhatsApp) dan token PUSH.
 *
 * Setiap konfigurasi punya dua sumber:
 *   1. Halaman Pengaturan (tabel `settings`) - inilah sumber utama.
 *   2. File `.env` - dipakai sebagai nilai bawaan.
 *
 * Aturannya: nilai dari UI menang selama key-nya benar-benar tersimpan di
 * database. Selama key belum pernah disimpan, nilai `.env` yang dipakai. Ini
 * membuat instalasi lama yang sudah punya MAIL_* di `.env` tetap jalan tanpa
 * harus diisi ulang di UI, sekaligus membuat perubahan lewat UI langsung
 * berlaku tanpa restart server.
 */

const config = require('../config');
const settingsService = require('./settings');

/** Ambil nilai dari DB kalau tersimpan, kalau tidak pakai nilai bawaan .env. */
function pick(stored, key, envValue, fallback = '') {
  if (Object.prototype.hasOwnProperty.call(stored, key)) {
    const value = stored[key];
    return value === '' || value === null || value === undefined ? fallback : value;
  }
  if (envValue === undefined || envValue === null || envValue === '') return fallback;
  return envValue;
}

function pickBool(stored, key, envValue) {
  const raw = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
  const source = raw === undefined ? envValue : raw;
  if (source === undefined || source === null || source === '') return false;
  if (typeof source === 'boolean') return source;
  return ['1', 'true', 'yes', 'on', 'ya'].includes(String(source).trim().toLowerCase());
}

function pickInt(stored, key, envValue, fallback) {
  const raw = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
  const source = raw === undefined ? envValue : raw;
  const n = Number.parseInt(String(source ?? '').trim(), 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Konfigurasi email gabungan UI + .env.
 * @returns {Promise<{enabled:boolean, host:string, port:number, secure:boolean,
 *   user:string, pass:string, from:string, source:object}>}
 */
async function mailConfig() {
  const stored = await settingsService.getStoredMap();

  const mail = {
    enabled: pickBool(stored, 'mail_enabled', config.mail.enabled),
    host: pick(stored, 'mail_host', config.mail.host, 'smtp.gmail.com'),
    port: pickInt(stored, 'mail_port', config.mail.port, 587),
    secure: pickBool(stored, 'mail_secure', config.mail.secure),
    user: pick(stored, 'mail_user', config.mail.user),
    pass: pick(stored, 'mail_pass', config.mail.pass),
    from: pick(stored, 'mail_from', config.mail.from, 'Aplikasi Absensi <absensi@contoh.com>'),
  };

  mail.configured = Boolean(mail.user && mail.pass);
  return mail;
}

/**
 * Konfigurasi WhatsApp gabungan UI + .env.
 * @returns {Promise<{enabled:boolean, provider:string, url:string, token:string, target:string,
 *   targetField:string, messageField:string, configured:boolean}>}
 */
async function whatsappConfig() {
  const stored = await settingsService.getStoredMap();

  const rawProvider = Object.prototype.hasOwnProperty.call(stored, 'whatsapp_provider')
    ? stored.whatsapp_provider
    : config.whatsapp.provider;
  const provider = String(rawProvider || 'gateway').trim().toLowerCase() === 'self' ? 'self' : 'gateway';

  const wa = {
    enabled: pickBool(stored, 'whatsapp_enabled', config.whatsapp.enabled),
    provider,
    url: pick(stored, 'whatsapp_url', config.whatsapp.url),
    token: pick(stored, 'whatsapp_token', config.whatsapp.token),
    target: pick(stored, 'whatsapp_target', config.whatsapp.target),
    targetField: pick(stored, 'whatsapp_field_target', config.whatsapp.targetField, 'target'),
    messageField: pick(stored, 'whatsapp_field_message', config.whatsapp.messageField, 'message'),
  };

  wa.configured = provider === 'self' ? Boolean(wa.target) : Boolean(wa.url && wa.target);
  return wa;
}

/**
 * Token PUSH mesin. Dibaca langsung tiap handshake / request supaya mengganti
 * token di UI berlaku tanpa restart.
 *
 * `push_port` sengaja TIDAK ikut di sini: port didengarkan sekali saat server
 * start, jadi mengubahnya di UI baru berlaku setelah restart. Nilai efektifnya
 * masih dikembalikan supaya UI bisa memberi tahu.
 */
async function pushConfig() {
  const stored = await settingsService.getStoredMap();

  return {
    token: pick(stored, 'push_auth_token', config.device.pushAuthToken),
    port: pickInt(stored, 'push_port', config.server.pushPort, 3001),
    // Port hanya berlaku setelah restart, jadi tandai untuk ditampilkan di UI.
    portNeedsRestart: pickInt(stored, 'push_port', config.server.pushPort, 3001) !== config.server.pushPort,
  };
}

/**
 * Buang cache transporter email. Wajib dipanggil setiap kali Pengaturan
 * disimpan, kalau tidak SMTP yang baru tidak akan dipakai.
 */
let mailer = null;
function invalidateMailer() {
  mailer = null;
}

/**
 * Ambil (atau buat) transporter nodemailer dari konfigurasi terbaru.
 * Mengembalikan null bila email tidak aktif atau belum lengkap.
 */
async function getMailer() {
  const mail = await mailConfig();
  if (!mail.enabled) return null;

  // Konfigurasi berubah sejak transport dibuat -> buat ulang.
  const signature = JSON.stringify([mail.host, mail.port, mail.secure, mail.user, mail.pass]);
  if (mailer && mailer.signature === signature) return mailer.transport;

  if (!mail.user || !mail.pass) {
    console.warn('[notify] Email diaktifkan tapi username/password SMTP kosong. Email dilewati.');
    return null;
  }

  // Dimuat malas supaya modul ini tetap bisa dipakai tanpa dependency bila
  // email tidak pernah dinyalakan.
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: { user: mail.user, pass: mail.pass },
  });

  mailer = { signature, transport };
  return transport;
}

module.exports = {
  mailConfig,
  whatsappConfig,
  pushConfig,
  getMailer,
  invalidateMailer,
};
