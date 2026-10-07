'use strict';

const db = require('../db/pool');
const channels = require('./channels');
const { today, longDate, formatTime, minutesToTime } = require('../utils/date');
const attendanceService = require('./attendance');

/**
 * Notifikasi WhatsApp & email.
 *
 * Keduanya memakai template dari tabel notification_templates supaya pesan bisa
 * diubah dari UI tanpa menyentuh kode. Bila template belum ada, dipakai
 * bawaan (DEFAULT_TEMPLATES).
 *
 * Placeholder yang didukung: {{nama}}, {{kode}}, {{tanggal}}, {{jam_masuk}},
 * {{jam_keluar}}, {{telat}}, {{status}}, {{total_hadir}}, {{total_telat}},
 * {{total_alpa}}, {{perangkat}}, {{pesan}}, {{periode}}
 */

const DEFAULT_TEMPLATES = {
  daily_reminder: {
    subject: 'Rekap Absensi {tanggal}',
    body:
      'Halo {nama},\n\n' +
      'Rekap absensi Anda hari ini, {tanggal}:\n' +
      '- Jam masuk   : {jam_masuk}\n' +
      '- Jam keluar  : {jam_keluar}\n' +
      '- Durasi kerja: {durasi}\n' +
      '- Status      : {status}\n' +
      'Keterlambatan: {telat} menit\n\n' +
      'Terima kasih.\n\n--\nNotifikasi otomatis dari Aplikasi Absensi',
  },
  late_notice: {
    subject: 'Peringatan Keterlambatan {tanggal}',
    body:
      'Halo {nama},\n\n' +
      'Anda tercatat telat {telat} menit pada {tanggal} ' +
      '(jam masuk {jam_masuk}, batas {batas_masuk}).\n\n' +
      'Mohon Ekoordinated dengan atasan Anda.\n\n--\nAplikasi Absensi',
  },
  sync_failed: {
    subject: 'Gagal Sinkronisasi Mesin Fingerprint',
    body:
      'Sinkronisasi dari mesin fingerprint gagal.\n\n' +
      'Perangkat : {perangkat}\n' +
      'Waktu    : {tanggal}\n' +
      'Pesan    : {pesan}\n\n' +
      'Segera periksa koneksi jaringan dan pengaturan mesin.\n\n--\nAplikasi Absensi',
  },
  monthly_report: {
    subject: 'Laporan Absensi {periode}',
    body:
      'Rekap absensi bulan {periode}:\n' +
      '- Total hadir : {total_hadir}\n' +
      '- Total telat : {total_telat}\n' +
      '- Total izin  : {total_izin}\n' +
      '- Total sakit : {total_sakit}\n' +
      '- Total alpa  : {total_alpa}\n\n' +
      '--\nAplikasi Absensi',
  },
};

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

async function getTemplate(eventKey, channel) {
  const row = await db.queryOne(
    'SELECT subject, body FROM notification_templates WHERE event_key = ? AND channel = ?',
    [eventKey, channel]
  );
  if (row) return row;

  const fallback = DEFAULT_TEMPLATES[eventKey];
  return fallback ? { subject: fallback.subject, body: fallback.body } : null;
}

function render(template, context) {
  return String(template)
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
      const value = context[key];
      return value === null || value === undefined ? '-' : String(value);
    })
    .replace(/\{(\w+)\}/g, (match, key) => {
      const value = context[key];
      return value === null || value === undefined ? '-' : String(value);
    });
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Kirim email memakai konfigurasi terbaru (UI Pengaturan, dengan .env sebagai
 * bawaan). Transport-nya di-cache di services/channels.js dan otomatis dibuat
 * ulang bila host/port/user berubah.
 */
async function sendEmail({ to, subject, body }) {
  const mail = await channels.mailConfig();
  if (!mail.enabled) return { ok: false, skipped: true, reason: 'Email tidak diaktifkan.' };

  const transport = await channels.getMailer();
  if (!transport) {
    return { ok: false, skipped: true, reason: 'Email diaktifkan tapi konfigurasi SMTP belum lengkap.' };
  }

  try {
    const info = await transport.sendMail({ from: mail.from, to, subject, text: body });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[notify] Email ke ${to} gagal: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/**
 * Pecah daftar penerima: "62812xxx, 62813xxx" -> ["62812xxx", "62813xxx"].
 * Dipakai kolom Nomor Penerima Default supaya bisa broadcast multi-nomor.
 */
function splitTargets(value) {
  const list = String(value || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Kirim WhatsApp via provider aktif.
 *
 * - provider 'self': kirim dari nomor sendiri (whatsapp-web.js, scan QR).
 * - provider 'gateway': HTTP gateway generik (Fonnte/Wablas/custom).
 *
 * Target boleh banyak (koma): tiap nomor dikirim satu per satu lewat antrean
 * anti-banned, jadi broadcast aman untuk nomor sendiri.
 *
 * Bila provider 'self' belum terhubung tapi gateway terisi lengkap, kirim
 * jatuh ke gateway supaya notifikasi penting tetap jalan.
 */
async function sendWhatsApp({ target, message, targets } = {}) {
  const wa = await channels.whatsappConfig();

  if (!wa.enabled) return { ok: false, skipped: true, reason: 'WhatsApp tidak diaktifkan.' };

  const recipients = [
    ...splitTargets(targets),
    ...splitTargets(target),
    ...splitTargets(wa.target),
  ].filter((t, i, arr) => arr.indexOf(t) === i);
  if (recipients.length === 0) return { ok: false, skipped: true, reason: 'Nomor tujuan WhatsApp belum diisi.' };

  if (wa.provider === 'self') {
    const waSelf = require('./whatsappSelf');
    const results = [];
    for (const recipient of recipients) {
      const direct = await waSelf.send({ target: recipient, message });
      if (direct.ok) {
        results.push({ target: recipient, ...direct });
        continue;
      }
      // Fallback ke gateway hanya bila gateway terisi lengkap.
      if (!wa.url) {
        results.push({ target: recipient, ...direct });
        continue;
      }
      const viaGateway = await sendViaGateway(wa, recipient, message);
      if (viaGateway.ok) {
        viaGateway.fallback = true;
        viaGateway.note = `Nomor sendiri gagal (${direct.error || 'belum terhubung'}), terkirim via gateway.`;
        results.push({ target: recipient, ...viaGateway });
      } else {
        results.push({ target: recipient, ...direct });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: okCount > 0,
      sent: okCount,
      total: results.length,
      results,
      ...(results.length === 1 ? results[0] : {}),
    };
  }

  if (recipients.length === 1) return sendViaGateway(wa, recipients[0], message);
  const results = [];
  for (const recipient of recipients) {
    results.push({ target: recipient, ...(await sendViaGateway(wa, recipient, message)) });
  }
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, sent: okCount, total: results.length, results };
}

async function sendViaGateway(wa, recipient, message) {
  if (!wa.url) return { ok: false, skipped: true, reason: 'URL gateway WhatsApp belum diisi di Pengaturan.' };

  const payload = {
    [wa.targetField]: recipient,
    [wa.messageField]: message,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (wa.token) {
    headers.Authorization = wa.token.startsWith('Bearer ')
      ? wa.token
      : `Bearer ${wa.token}`;
  }

  try {
    const response = await fetch(wa.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    const text = await response.text();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, response: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Pengiriman
// ---------------------------------------------------------------------------

/** Kirim ke semua channel yang diminta. Hasil per channel dikembalikan. */
async function dispatch({ eventKey, to, subject, body }) {
  const results = { email: null, whatsapp: null };

  if (to.email) {
    const tpl = await getTemplate(eventKey, 'email');
    results.email = await sendEmail({
      to: to.email,
      subject: subject || (tpl ? render(tpl.subject || eventKey, body) : eventKey),
      body: tpl ? render(tpl.body, body) : String(body.pesan || ''),
    });
  }

  if (to.whatsapp) {
    const tpl = await getTemplate(eventKey, 'whatsapp');
    const message = tpl ? render(tpl.body, body) : String(body.pesan || '');
    results.whatsapp = await sendWhatsApp({ target: to.whatsapp, message });
  }

  return results;
}

/** Kirim ringkasan harian ke seorang karyawan. */
async function notifyDaily(employee, workDate = today()) {
  const detail = await attendanceService.getOne(employee.id, workDate);
  const daily = detail.daily;

  if (!daily) {
    return { ok: false, reason: `Rekap ${workDate} belum dibuat untuk karyawan ini.` };
  }

  const template = await getTemplate('daily_reminder', 'whatsapp') || DEFAULT_TEMPLATES.daily_reminder;
  const body = {
    nama: employee.name,
    kode: employee.employee_code,
    tanggal: longDate(workDate),
    jam_masuk: formatTime(daily.first_in) || '-',
    jam_keluar: formatTime(daily.first_out) || '-',
    durasi: formatMinutes(daily.work_minutes),
    status: attendanceService.STATUS_LABEL[daily.status] || daily.status,
    telat: daily.late_minutes,
    lembur: formatMinutes(daily.overtime_minutes),
  };

  return dispatch({
    eventKey: 'daily_reminder',
    to: { email: employee.email, whatsapp: employee.phone },
    body,
  });
}

/** Peringatan keterlambatan untuk semua karyawan telat pada satu tanggal. */
async function notifyLateEmployees(workDate = today(), departmentId = null) {
  const params = [workDate];
  let where = 'd.work_date = ? AND d.late_minutes > 0';
  if (departmentId) {
    where += ' AND e.department_id = ?';
    params.push(Number(departmentId));
  }

  const rows = await db.queryAll(
    `SELECT e.id, e.name, e.employee_code, e.email, e.phone,
            d.late_minutes, d.first_in
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
      WHERE ${where}`,
    params
  );

  if (rows.length === 0) {
    return { ok: true, sent: 0, message: 'Tidak ada karyawan telat pada tanggal tersebut.' };
  }

  const sent = [];
  for (const row of rows) {
    const result = await dispatch({
      eventKey: 'late_notice',
      to: { email: row.email, whatsapp: row.phone },
      body: {
        nama: row.name,
        kode: row.employee_code,
        tanggal: longDate(workDate),
        jam_masuk: formatTime(row.first_in),
        telat: row.late_minutes,
      },
    });

    const delivered = result.email?.ok || result.whatsapp?.ok;
    if (delivered) sent.push({ id: row.id, name: row.name });
  }

  return { ok: true, total: rows.length, sent: sent.length, recipients: sent };
}

function addMinutes(time, minutes) {
  const [h, m] = String(time ?? '00:00').split(':').map(Number);
  return minutesToTime((h * 60 + m + minutes) % 1440);
}

function formatMinutes(minutes) {
  const total = Number(minutes || 0);
  if (total <= 0) return '-';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} menit`;
  if (m === 0) return `${h} jam`;
  return `${h} jam ${m} menit`;
}

/** Notifikasi kalau ada mesin yang gagal disinkronkan. */
async function notifySyncFailed(summary) {
  const failed = (summary.devices || []).filter((d) => !d.ok);
  if (failed.length === 0) return { ok: true, skipped: true };

  // Notifikasi ini untuk admin, bukan karyawan, jadi tujuan defaultnya adalah
  // target WhatsApp / akun SMTP yang diisi di Pengaturan.
  const wa = await channels.whatsappConfig();
  const mail = await channels.mailConfig();
  const adminTarget = { whatsapp: wa.target || null, email: mail.user || null };

  const results = [];
  for (const device of failed) {
    const result = await dispatch({
      eventKey: 'sync_failed',
      to: adminTarget,
      body: {
        perangkat: device.name,
        tanggal: new Date().toLocaleString('id-ID'),
        pesan: device.message || 'Tidak diketahui',
      },
    });
    results.push({ device: device.name, ...result });
  }

  return { ok: true, sent: results.length, results };
}

/** Kirim laporan bulanan ke penerima tertentu. */
async function sendMonthlyReport({ month, to }) {
  const from = `${month}-01`;
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to_ = `${month}-${String(lastDay).padStart(2, '0')}`;

  const summary = await attendanceService.summary({ from, to: to_ });
  const s = summary.by_status;

  return dispatch({
    eventKey: 'monthly_report',
    to,
    body: {
      periode: month,
      total_hadir: s.hadir || 0,
      total_telat: s.telat || 0,
      total_izin: s.izin || 0,
      total_sakit: s.sakit || 0,
      total_alpa: s.alpa || 0,
      total_cuti: s.cuti || 0,
    },
  });
}

let statusCache = null;
let statusStamp = 0;

function invalidateStatusCache() {
  statusCache = null;
  statusStamp = 0;
}

/**
 * Status kanal notifikasi untuk halaman Pengaturan.
 * Nilai dibaca dari konfigurasi yang benar-benar dipakai saat kirim, supaya
 * yang tampil di UI sama dengan yang benar-benar dipakai.
 * Cache 30 detik: dashboard memanggil tiap refresh, tanpa cache = 2 query
 * settings berulang yang menumpuk antrean pool.
 */
async function status() {
  if (statusCache && Date.now() - statusStamp < 30000) return statusCache;
  const mail = await channels.mailConfig();
  const wa = await channels.whatsappConfig();

  let waSelf = null;
  if (wa.provider === 'self') {
    try {
      waSelf = await require('./whatsappSelf').status();
    } catch {
      waSelf = null;
    }
  }

  const waProblem = !wa.enabled
    ? null
    : wa.provider === 'self'
      ? (!wa.target
        ? 'Nomor tujuan default belum diisi.'
        : !waSelf?.ready
          ? 'Nomor sendiri belum terhubung. Scan QR di Pengaturan.'
          : null)
      : !wa.url
        ? 'URL gateway belum diisi.'
        : !wa.target
          ? 'Nomor tujuan default belum diisi.'
          : null;

  statusCache = {
    email: {
      enabled: mail.enabled,
      configured: mail.configured,
      host: mail.host,
      port: mail.port,
      user: mail.user || null,
      from: mail.from,
      // Sarat agar email benar-benar terkirim.
      problem: !mail.enabled
        ? null
        : !mail.configured
          ? 'Username atau password SMTP belum diisi.'
          : null,
    },
    whatsapp: {
      enabled: wa.enabled,
      provider: wa.provider,
      configured: wa.configured,
      gateway: wa.provider === 'self'
        ? (waSelf?.phone ? `Nomor sendiri +${waSelf.phone}` : 'Nomor sendiri (scan QR)')
        : (wa.url ? maskUrl(wa.url) : null),
      target: wa.target || null,
      self: waSelf,
      problem: waProblem,
    },
  };
  statusStamp = Date.now();
  return statusCache;
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(url tidak valid)';
  }
}

module.exports = {
  dispatch,
  notifyDaily,
  notifyLateEmployees,
  notifySyncFailed,
  sendMonthlyReport,
  status,
  invalidateStatusCache,
  getTemplate,
  render,
  formatMinutes,
  sendEmail,
  sendWhatsApp,
  splitTargets,
  DEFAULT_TEMPLATES,
};
