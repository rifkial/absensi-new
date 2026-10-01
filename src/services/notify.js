'use strict';

const nodemailer = require('nodemailer');
const db = require('../db/pool');
const config = require('../config');
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

let mailer = null;

function getMailer() {
  if (mailer) return mailer;
  if (!config.mail.enabled) return null;
  if (!config.mail.user || !config.mail.pass) {
    console.warn('[notify] MAIL_ENABLED=true tapi MAIL_USER/MAIL_PASS kosong. Email dilewati.');
    return null;
  }

  mailer = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });

  return mailer;
}

async function sendEmail({ to, subject, body }) {
  const transport = getMailer();
  if (!transport) return { ok: false, skipped: true, reason: 'Email tidak diaktifkan.' };

  try {
    const info = await transport.sendMail({ from: config.mail.from, to, subject, text: body });
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
 * Kirim WhatsApp lewat HTTP gateway generik.
 *
 * Konfigurasi: WHATSAPP_URL + WHATSAPP_TOKEN + target/field message.
 * Secara bawaan payload-nya { target, message }, yang cocok dengan gateway
 * Fonnte/Wablas. Sesuaikan WHATSAPP_FIELD_* bila gateway Anda berbeda.
 */
async function sendWhatsApp({ target, message }) {
  if (!config.whatsapp.enabled) return { ok: false, skipped: true, reason: 'WhatsApp tidak diaktifkan.' };
  if (!config.whatsapp.url) return { ok: false, skipped: true, reason: 'WHATSAPP_URL belum diisi.' };

  const recipient = target || config.whatsapp.target;
  if (!recipient) return { ok: false, skipped: true, reason: 'Nomor tujuan WhatsApp belum diisi.' };

  const payload = {
    [config.whatsapp.targetField]: recipient,
    [config.whatsapp.messageField]: message,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (config.whatsapp.token) {
    headers.Authorization = config.whatsapp.token.startsWith('Bearer ')
      ? config.whatsapp.token
      : `Bearer ${config.whatsapp.token}`;
  }

  try {
    const response = await fetch(config.whatsapp.url, {
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
            d.late_minutes, d.first_in, d.shift_code,
            s.start_time, s.late_tolerance_min
       FROM attendance_daily d
       JOIN employees e ON e.id = d.employee_id
       LEFT JOIN shifts s ON s.id = d.shift_id
      WHERE ${where}`,
    params
  );

  if (rows.length === 0) {
    return { ok: true, sent: 0, message: 'Tidak ada karyawan telat pada tanggal tersebut.' };
  }

  const sent = [];
  for (const row of rows) {
    const tolerance = Number(row.late_tolerance_min ?? 0);
    const batas = addMinutes(row.start_time, tolerance);

    const result = await dispatch({
      eventKey: 'late_notice',
      to: { email: row.email, whatsapp: row.phone },
      body: {
        nama: row.name,
        kode: row.employee_code,
        tanggal: longDate(workDate),
        jam_masuk: formatTime(row.first_in),
        batas_masuk: batas,
        telat: row.late_minutes,
        shift: row.shift_code,
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

  const results = [];
  for (const device of failed) {
    const result = await dispatch({
      eventKey: 'sync_failed',
      to: { whatsapp: config.whatsapp.target, email: config.mail.user },
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

function status() {
  return {
    email: {
      enabled: config.mail.enabled,
      configured: Boolean(config.mail.user && config.mail.pass),
      from: config.mail.from,
    },
    whatsapp: {
      enabled: config.whatsapp.enabled,
      configured: Boolean(config.whatsapp.url && config.whatsapp.target),
      gateway: config.whatsapp.url ? maskUrl(config.whatsapp.url) : null,
    },
  };
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
  getTemplate,
  render,
  formatMinutes,
  sendEmail,
  sendWhatsApp,
  DEFAULT_TEMPLATES,
};
