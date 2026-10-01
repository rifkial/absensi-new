/* =============================================================================
 * Halaman PENGATURAN
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};
  var tab = 'general';

  window.Pages.settings = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            '<button class="btn ' + (tab === 'general' ? 'primary' : '') + '" data-tab="general">Pengaturan Umum</button>' +
            '<button class="btn ' + (tab === 'attendance' ? 'primary' : '') + '" data-tab="attendance">Absensi &amp; Jam Kerja</button>' +
            '<button class="btn ' + (tab === 'device' ? 'primary' : '') + '" data-tab="device">Perangkat &amp; Sinkron</button>' +
            '<button class="btn ' + (tab === 'notify' ? 'primary' : '') + '" data-tab="notify">Notifikasi</button>' +
            '<button class="btn ' + (tab === 'system' ? 'primary' : '') + '" data-tab="system">Status Sistem</button>' +
          '</div>' +
          '<div class="btn-group">' +
            '<button class="btn" id="setReload">&#8635; Muat Ulang</button>' +
            (App.can('settings:write') ? '<button class="btn primary" id="setSave">Simpan Perubahan</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="setBody"></div>';

    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        window.Pages.settings(root);
      });
    });

    var reload = document.getElementById('setReload');
    if (reload) reload.addEventListener('click', load);

    load();
  };

  var cached = {};

  function load() {
    var box = document.getElementById('setBody');
    box.innerHTML = App.loading('Memuat pengaturan...');

    api.get('/settings')
      .then(function (res) {
        cached = res.data || {};
        if (tab === 'general') paintGeneral(cached, box);
        else if (tab === 'attendance') paintAttendance(cached, box);
        else if (tab === 'device') paintDevice(cached, box);
        else if (tab === 'notify') paintNotify(cached, box);
        else paintSystem(box);
      })
      .catch(function (err) {
        box.innerHTML = '<div class="card"><div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div></div>';
      });
  }

  function field(label, id, value, type, placeholder, min, max, help) {
    var v = value === null || value === undefined ? '' : String(value);
    var attrs = '';
    if (placeholder) attrs += ' placeholder="' + esc(placeholder) + '"';
    if (min !== undefined && min !== '') attrs += ' min="' + min + '"';
    if (max !== undefined && max !== '') attrs += ' max="' + max + '"';
    var helpHtml = help ? '<span class="help">' + help + '</span>' : '';
    return '<div class="field"><label>' + esc(label) + '</label><input type="' + type + '" id="' + id + '" value="' + esc(v) + '"' + attrs + '>' + helpHtml + '</div>';
  }

  function toBool(v) {
    if (v === true || v === 1) return true;
    if (!v) return false;
    return ['1', 'true', 'yes', 'on', 'ya'].indexOf(String(v).toLowerCase()) >= 0;
  }

  function paintGeneral(s, box) {
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2 class="card-title">Pengaturan Umum</h2><p class="card-subtitle">Informasi dasar aplikasi</p></div></div>' +
        '<div class="card-body">' +
          '<div class="form-grid">' +
            field('Nama Aplikasi', 'app_name', s.app_name, 'text', 'Aplikasi Absensi Fingerprint') +
            field('Nama Perusahaan', 'company_name', s.company_name, 'text', 'PT Contoh Sejahtera') +
            field('Zona Waktu', 'timezone', s.timezone, 'text', 'Asia/Jakarta') +
            field('Pengingat Telat (HH:MM)', 'late_reminder_time', s.late_reminder_time, 'time') +
            field('Pengumuman Harian (HH:MM)', 'daily_notify_time', s.daily_notify_time, 'time') +
            field('Hari Laporan Bulanan (1-31)', 'monthly_report_day', s.monthly_report_day, 'number', '', '1', '31') +
          '</div>' +
        '</div>' +
      '</div>';

    bindSave();
  }

  function paintAttendance(s, box) {
    box.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Perilaku Absensi</h2><p class="card-subtitle">Aturan global perhitungan absensi</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              field('Batas Akhir Scan (HH:MM:SS)', 'attendance_cutoff_time', s.attendance_cutoff_time, 'text', '23:59:59', '', '', 'Karyawan dianggap alpa jika belum absen setelah melewati batas ini') +
              field('Toleransi Telat Default (menit)', 'default_late_tolerance', s.default_late_tolerance, 'number', '', '0', '240') +
              field('Maks. Jam Kerja Harian (menit)', 'max_daily_work_minutes', s.max_daily_work_minutes, 'number', '', '0', '1440') +
              field('Backfill Rekap (hari terakhir)', 'backfill_days', s.backfill_days, 'number', '', '0', '365') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Jam Kerja Global</h2><p class="card-subtitle">Dipakai jika karyawan tidak memiliki Shift &amp; Jadwal</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="use_global_when_no_shift"' + (toBool(s.use_global_when_no_shift) ? ' checked' : '') + '><label for="use_global_when_no_shift">Gunakan Jam Kerja Global bila tidak ada Shift</label></div>' +
              field('Jam Masuk Global (HH:MM)', 'global_check_in', s.global_check_in, 'time') +
              field('Jam Pulang Global (HH:MM)', 'global_check_out', s.global_check_out, 'time') +
              field('Toleransi Keterlambatan (menit)', 'global_late_tolerance', s.global_late_tolerance, 'number', '', '0', '240') +
              field('Istirahat Mulai (opsional)', 'global_break_start', s.global_break_start || '', 'time') +
              field('Istirahat Selesai (opsional)', 'global_break_end', s.global_break_end || '', 'time') +
            '</div>' +
            '<div class="callout mt"><strong>Prioritas aturan jam kerja:</strong> Jadwal per tanggal (Shift Override) &gt; Shift Default Karyawan &gt; <strong>Jam Kerja Global</strong>.</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    bindSave();
  }

  function paintDevice(s, box) {
    box.innerHTML =
      '<div class="card">' +
        '<div class="card-header"><div><h2 class="card-title">Sinkronisasi &amp; Perangkat</h2><p class="card-subtitle">Pengaturan polling &amp; PUSH mesin fingerprint</p></div></div>' +
        '<div class="card-body">' +
          '<div class="form-grid">' +
            field('Interval Sinkron (menit)', 'sync_interval_minutes', s.sync_interval_minutes, 'number', '', '1', '1440') +
            field('Timeout Mesin (ms)', 'device_timeout_ms', s.device_timeout_ms, 'number', '', '1000', '120000') +
            '<div class="field checkbox full"><input type="checkbox" id="device_clear_log_after_sync"' + (toBool(s.device_clear_log_after_sync) ? ' checked' : '') + '><label for="device_clear_log_after_sync">Hapus log di mesin setelah sinkron</label></div>' +
            field('Port PUSH (ADMS)', 'push_port', s.push_port, 'number', '', '1', '65535') +
            field('Token PUSH (opsional)', 'push_auth_token', s.push_auth_token, 'password', '') +
          '</div>' +
        '</div>' +
      '</div>';

    bindSave();
  }

  function paintNotify(s, box) {
    box.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Email (SMTP)</h2><p class="card-subtitle">Kirim notifikasi via email</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="mail_enabled"' + (toBool(s.mail_enabled) ? ' checked' : '') + '><label for="mail_enabled">Aktifkan Email</label></div>' +
              field('SMTP Host', 'mail_host', s.mail_host, 'text', 'smtp.gmail.com') +
              field('SMTP Port', 'mail_port', s.mail_port, 'number', '', '1', '65535') +
              '<div class="field checkbox full"><input type="checkbox" id="mail_secure"' + (toBool(s.mail_secure) ? ' checked' : '') + '><label for="mail_secure">Gunakan TLS (secure)</label></div>' +
              field('Username SMTP', 'mail_user', s.mail_user, 'text') +
              field('Password SMTP', 'mail_pass', s.mail_pass, 'password') +
              field('Alamat Pengirim', 'mail_from', s.mail_from, 'text', 'Aplikasi Absensi <absensi@contoh.com>') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">WhatsApp Gateway</h2><p class="card-subtitle">Fonnte, Wablas atau gateway custom</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="whatsapp_enabled"' + (toBool(s.whatsapp_enabled) ? ' checked' : '') + '><label for="whatsapp_enabled">Aktifkan WhatsApp</label></div>' +
              field('URL Gateway', 'whatsapp_url', s.whatsapp_url, 'url', 'https://api.fonnte.com/send') +
              field('Token/Bearer', 'whatsapp_token', s.whatsapp_token, 'password') +
              field('Nomor Target Default', 'whatsapp_target', s.whatsapp_target, 'text', '62812xxxxxxx') +
              field('Field Target (JSON)', 'whatsapp_field_target', s.whatsapp_field_target, 'text', 'target') +
              field('Field Pesan (JSON)', 'whatsapp_field_message', s.whatsapp_field_message, 'text', 'message') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    bindSave();
  }

  function paintSystem(box) {
    if (window.Pages && typeof window.Pages.settingsStatus === 'function') {
      window.Pages.settingsStatus(box);
      return;
    }
    box.innerHTML = '<div class="card"><div class="empty-state"><div class="big">&#9881;</div><div>Halaman status sistem belum siap.</div></div></div>';
  }

  function bindSave() {
    var btn = document.getElementById('setSave');
    if (!btn) return;
    btn.onclick = function () {
      if (!App.can('settings:write')) { App.toast('Tidak punya hak akses.', 'error'); return; }
      var body = document.getElementById('setBody');
      var payload = {
        app_name: getVal(body, '#app_name'),
        company_name: getVal(body, '#company_name'),
        timezone: getVal(body, '#timezone'),
        late_reminder_time: getVal(body, '#late_reminder_time'),
        daily_notify_time: getVal(body, '#daily_notify_time'),
        monthly_report_day: numVal(body, '#monthly_report_day', 1),
        attendance_cutoff_time: getVal(body, '#attendance_cutoff_time'),
        default_late_tolerance: numVal(body, '#default_late_tolerance', 10),
        max_daily_work_minutes: numVal(body, '#max_daily_work_minutes', 600),
        backfill_days: numVal(body, '#backfill_days', 30),
        use_global_when_no_shift: chkVal(body, '#use_global_when_no_shift'),
        global_check_in: getVal(body, '#global_check_in') || '08:00',
        global_check_out: getVal(body, '#global_check_out') || '17:00',
        global_late_tolerance: numVal(body, '#global_late_tolerance', 10),
        global_break_start: getVal(body, '#global_break_start') || '',
        global_break_end: getVal(body, '#global_break_end') || '',
        sync_interval_minutes: numVal(body, '#sync_interval_minutes', 5),
        device_timeout_ms: numVal(body, '#device_timeout_ms', 20000),
        device_clear_log_after_sync: chkVal(body, '#device_clear_log_after_sync'),
        push_port: numVal(body, '#push_port', 3001),
        push_auth_token: getVal(body, '#push_auth_token'),
        mail_enabled: chkVal(body, '#mail_enabled'),
        mail_host: getVal(body, '#mail_host'),
        mail_port: numVal(body, '#mail_port', 587),
        mail_secure: chkVal(body, '#mail_secure'),
        mail_user: getVal(body, '#mail_user'),
        mail_pass: getVal(body, '#mail_pass'),
        mail_from: getVal(body, '#mail_from'),
        whatsapp_enabled: chkVal(body, '#whatsapp_enabled'),
        whatsapp_url: getVal(body, '#whatsapp_url'),
        whatsapp_token: getVal(body, '#whatsapp_token'),
        whatsapp_target: getVal(body, '#whatsapp_target'),
        whatsapp_field_target: getVal(body, '#whatsapp_field_target'),
        whatsapp_field_message: getVal(body, '#whatsapp_field_message'),
      };

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Menyimpan...';
      api.put('/settings', payload)
        .then(function () { App.toast('Pengaturan berhasil disimpan.', 'success'); })
        .catch(function (err) { App.toast(err.message, 'error'); })
        .then(function () { btn.disabled = false; btn.textContent = 'Simpan Perubahan'; });
    };
  }

  function getVal(root, sel) {
    var el = root.querySelector(sel);
    return el ? el.value : '';
  }
  function numVal(root, sel, def) {
    var v = getVal(root, sel);
    if (!v) return def;
    var n = Number(v);
    return isFinite(n) ? n : def;
  }
  function chkVal(root, sel) {
    var el = root.querySelector(sel);
    return el ? el.checked : false;
  }
})();
