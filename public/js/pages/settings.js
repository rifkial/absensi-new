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
            '<button class="btn ' + (tab === 'attendance' ? 'primary' : '') + '" data-tab="attendance">Jadwal Global</button>' +
            '<button class="btn ' + (tab === 'holiday' ? 'primary' : '') + '" data-tab="holiday">Hari Libur</button>' +
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
        else if (tab === 'holiday') paintHoliday(cached, box);
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

  /* 1..6 = Senin..Sabtu. Minggu (7) sengaja tidak ditampilkan karena hari
     Minggu tidak pernah boleh dipilih sebagai hari kerja. */
  var DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  /**
   * Pemilih hari kerja (1..6 = Senin..Sabtu, sama seperti shifts.work_days).
   * Nilai disimpan sebagai input tersembunyi "1,2,3,4,5" agar cocok dengan
   * kolom work_days di tabel shifts.
   */
  function workDaysField(value) {
    var selected = String(value || '1,2,3,4,5')
      .split(',')
      .map(function (v) { return Number(v.trim()); })
      .filter(function (v) { return v >= 1 && v <= 6; });
    if (selected.length === 0) selected = [1, 2, 3, 4, 5];

    var boxes = DAY_NAMES.map(function (name, i) {
      var day = i + 1;
      var on = selected.indexOf(day) >= 0;
      return '<div class="field checkbox full" style="grid-column:auto">' +
        '<input type="checkbox" class="wdDay" value="' + day + '" id="wd' + day + '"' + (on ? ' checked' : '') + '>' +
        '<label for="wd' + day + '">' + name + '</label></div>';
    }).join('');

    return '<div class="field full"><label for="global_work_days">Hari Kerja</label>' +
      '<input type="hidden" id="global_work_days" value="' + esc(selected.join(',')) + '">' +
      '<div class="row" id="wdRow" style="gap:14px;flex-wrap:wrap">' + boxes + '</div>' +
      '<span class="help">Hari yang tidak dicentang tidak dihitung sebagai hari kerja (tidak menambah persentase kehadiran, tidak menambah alpa). ' +
      'Hari Minggu selalu libur dan tidak bisa dipilih.</span>' +
      '</div>';
  }

  /**
   * Sinkronkan input tersembunyi global_work_days dengan checkbox hari.
   * Mengembalikan undefined bila tab Jadwal Global tidak sedang tampil, supaya
   * payload tidak menimpa nilai global_work_days yang sudah tersimpan.
   */
  function syncWorkDays() {
    var hidden = document.getElementById('global_work_days');
    if (!hidden) return undefined;
    var picked = Array.prototype.slice
      .call(document.querySelectorAll('.wdDay'))
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return Number(cb.value); })
      .sort(function (a, b) { return a - b; });
    if (picked.length === 0) {
      App.toast('Pilih minimal satu hari kerja.', 'error');
      return undefined;
    }
    hidden.value = picked.join(',');
    return hidden.value;
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
          '<div class="card-header"><div><h2 class="card-title">Jadwal Global</h2>' +
          '<p class="card-subtitle">Hari kerja, jam masuk, jam pulang, dan jam istirahat</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              workDaysField(s.global_work_days) +
              field('Jam Masuk (HH:MM)', 'global_check_in', s.global_check_in, 'time') +
              field('Jam Pulang (HH:MM)', 'global_check_out', s.global_check_out, 'time') +
              field('Istirahat Mulai (HH:MM)', 'global_break_start', s.global_break_start || '', 'time', 'Kosongkan bila tidak ada istirahat') +
              field('Istirahat Selesai (HH:MM)', 'global_break_end', s.global_break_end || '', 'time', 'Kosongkan bila tidak ada istirahat') +
              field('Toleransi Terlambat (menit)', 'global_late_tolerance', s.global_late_tolerance, 'number', '', '0', '240') +
              '<div class="field checkbox full"><input type="checkbox" id="use_global_when_no_shift"' + (toBool(s.use_global_when_no_shift) ? ' checked' : '') + '><label for="use_global_when_no_shift">Pakai Jadwal Global bila karyawan tidak punya shift</label></div>' +
            '</div>' +
            '<div class="callout mt"><strong>Siapa yang memakai Jadwal Global?</strong>' +
            'Hanya karyawan yang <strong>tidak punya shift</strong>. Karyawan dengan shift sendiri ' +
            'mengikuti jam shift-nya. Urutan aturan: Jadwal per tanggal &gt; Shift Default Karyawan &gt; Jadwal Global.</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Perilaku Absensi</h2><p class="card-subtitle">Aturan umum perhitungan absensi</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              field('Batas Akhir Scan (HH:MM:SS)', 'attendance_cutoff_time', s.attendance_cutoff_time, 'text', '23:59:59', '', '', 'Karyawan dianggap alpa jika belum absen setelah melewati batas ini') +
              field('Toleransi Telat Default (menit)', 'default_late_tolerance', s.default_late_tolerance, 'number', '', '0', '240') +
              field('Maks. Jam Kerja Harian (menit)', 'max_daily_work_minutes', s.max_daily_work_minutes, 'number', '', '0', '1440') +
              field('Backfill Rekap (hari terakhir)', 'backfill_days', s.backfill_days, 'number', '', '0', '365') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    bindSave();
  }

  function paintHoliday(s, box) {
    box.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Sinkronisasi Hari Libur</h2>' +
          '<p class="card-subtitle">Ambil daftar libur nasional Indonesia dari API secara otomatis</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="holiday_sync_enabled"' +
                (toBool(s.holiday_sync_enabled) ? ' checked' : '') + '>' +
                '<label for="holiday_sync_enabled">Sinkronkan hari libur nasional otomatis</label></div>' +
              field('Interval Sinkron (hari)', 'holiday_sync_interval_days', s.holiday_sync_interval_days, 'number', '', '1', '365',
                'Berapa lama jarak antar sinkronisasi. 30 = sekali sebulan.') +
              field('Tahun ke Depan', 'holiday_sync_years_ahead', s.holiday_sync_years_ahead, 'number', '', '0', '5',
                'Besides tahun berjalan, berapa tahun berikutnya ikut diunduh. 1 = sampai tahun depan.') +
              '<div class="field"><label>Sinkron Terakhir</label>' +
                '<input type="text" id="holiday_sync_last_at" value="' +
                esc(s.holiday_sync_last_at ? App.fmtDate(s.holiday_sync_last_at) : 'belum pernah') + '" disabled>' +
                '<span class="help">Diisi otomatis oleh sistem.</span></div>' +
            '</div>' +
            '<div class="callout mt"><strong>Cara kerjanya</strong> ' +
              'Saat server berjalan, daftar libur diunduh dari API publik hari libur nasional Indonesia (gratis, tanpa API key) ' +
              'bila sudah lewat interval di atas. Hasilnya disimpan di tabel <code>holidays</code>, jadi rekap absensi tetap bisa ' +
              'dihitung walau internet mati. Tanggal libur otomatis berstatus <strong>Hari Libur</strong> dan tidak dihitung alpa.</div>' +
            '<div class="callout mt"><strong>Tambah hari libur sendiri</strong> ' +
              'Buka menu <strong>Hari Libur</strong> untuk menambah libur tambahan perusahaan atau mengubah data hasil sinkronisasi. ' +
              'Perubahan manual tidak akan ditimpa saat sinkron ulang.</div>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Libur Tambahan</h2>' +
          '<p class="card-subtitle">Daftar libur yang akan datang</p></div>' +
          '<div id="hlPreview"></div>' +
        '</div>' +
      '</div>';

    bindSave();

    // Pratinjau 8 libur terdekat supaya admin bisa sanity-check tanpa pindah menu.
    api.get('/holidays/upcoming?days=180')
      .then(function (res) {
        var list = (res.data || []).slice(0, 8);
        var target = document.getElementById('hlPreview');
        if (!target) return;
        target.style.padding = '14px 16px';
        target.innerHTML = list.length === 0
          ? '<div class="small faint">Belum ada hari libur terdaftar. Klik "Sinkronkan dari API" di menu Hari Libur.</div>'
          : list.map(function (h) {
              return '<div class="small" style="padding:3px 0">' +
                '<strong>' + esc(App.fmtDate(h.holiday_date)) + '</strong> - ' + esc(h.name) +
                (Number(h.is_workday) === 1 ? ' <span class="badge warning">Tetap bekerja</span>' : '') +
                '</div>';
            }).join('');
      })
      .catch(function () {});
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
            '<div class="field checkbox full"><input type="checkbox" id="enforce_assigned_device"' + (toBool(s.enforce_assigned_device) ? ' checked' : '') + '><label for="enforce_assigned_device">Tolak scan di mesin yang tidak ditunjuk</label>' +
              '<span class="help">Bila aktif, scan karyawan pada mesin fingerprint yang tidak ditunjuk di data karyawan TIDAK dicatat dan tidak dihitung sebagai kehadiran. Hanya berlaku untuk scan dari mesin (sinkronisasi/PUSH); impor CSV dan pencatatan manual tetap disimpan.</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Kendaraan Operasional</h2>' +
          '<p class="card-subtitle">Dipakai pada surat pengantar mobil keluar (dinas luar kota)</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              field('Nomor Kendaraan', 'operational_vehicle', s.operational_vehicle, 'text', 'Contoh: B 1234 XYZ - Avanza') +
              field('Penandatangan Pengantar', 'vehicle_signatory', s.vehicle_signatory, 'text', 'Contoh: Kepala Bagian') +
            '</div>' +
            '<div class="callout">Data di atas dipakai otomatis saat mencetak pengantar mobil keluar ' +
              'untuk pengajuan dinas luar kota yang memakai kendaraan operasional.</div>' +
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

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Keamanan Login</h2>' +
          '<p class="card-subtitle">Pembatas percobaan login untuk menahan brute force</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="login_rate_limit_enabled"' +
                (toBool(s.login_rate_limit_enabled) ? ' checked' : '') +
                '><label for="login_rate_limit_enabled">Aktifkan Pembatas Login</label></div>' +
              field('Percobaan Gratis', 'login_free_attempts', s.login_free_attempts, 'number', '', '1', '100',
                'Jumlah salah ketik yang masih bebas sebelum permintaan ditunda.') +
              field('Ambang Kunci Akun', 'login_lock_threshold', s.login_lock_threshold, 'number', '', '1', '1000',
                'Total gagal untuk satu username sebelum akun dikunci sementara.') +
              field('Durasi Kunci (detik)', 'login_lock_seconds', s.login_lock_seconds, 'number', '', '30', '86400',
                'Lama akun terkunci. 900 detik = 15 menit.') +
            '</div>' +
            '<div class="callout mt"><strong>Cara kerjanya</strong>' +
            'Percobaan yang gagal dihitung per pasangan alamat IP dan username. Setelah melewati Percobaan Gratis, ' +
            'permintaan berikutnya harus menunggu dan jeda bertambah setiap kali gagal. Bila satu username gagal ' +
            'sebanyak Ambang Kunci Akun (bisa dari IP berbeda), akunnya dikunci selama Durasi Kunci. ' +
            'Riwayat hanya bertambah pada login gagal, jadi login berhasil langsung membersihkan hitungan.</div>' +
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
      var payload = compact({
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
        global_work_days: syncWorkDays(),
        global_check_in: orDefault(getVal(body, '#global_check_in'), '08:00'),
        global_check_out: orDefault(getVal(body, '#global_check_out'), '17:00'),
        global_late_tolerance: numVal(body, '#global_late_tolerance', 10),
        global_break_start: orDefault(getVal(body, '#global_break_start'), ''),
        global_break_end: orDefault(getVal(body, '#global_break_end'), ''),
        holiday_sync_enabled: chkVal(body, '#holiday_sync_enabled'),
        holiday_sync_interval_days: numVal(body, '#holiday_sync_interval_days', 30),
        holiday_sync_years_ahead: numVal(body, '#holiday_sync_years_ahead', 1),
        sync_interval_minutes: numVal(body, '#sync_interval_minutes', 5),
        device_timeout_ms: numVal(body, '#device_timeout_ms', 20000),
        device_clear_log_after_sync: chkVal(body, '#device_clear_log_after_sync'),
        push_port: numVal(body, '#push_port', 3001),
        push_auth_token: getVal(body, '#push_auth_token'),
        operational_vehicle: getVal(body, '#operational_vehicle'),
        vehicle_signatory: getVal(body, '#vehicle_signatory'),
        enforce_assigned_device: chkVal(body, '#enforce_assigned_device'),
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

        login_rate_limit_enabled: chkVal(body, '#login_rate_limit_enabled'),
        login_free_attempts: numVal(body, '#login_free_attempts', 5),
        login_lock_threshold: numVal(body, '#login_lock_threshold', 10),
        login_lock_seconds: numVal(body, '#login_lock_seconds', 900),
      });

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Menyimpan...';
      api.put('/settings', payload)
        .then(function (res) {
          // Server bisa memberi tahu bahwa ada pengaturan yang baru berlaku
          // setelah restart, jadi pesan baliknya dipakai apa adanya.
          App.toast(res.message || 'Pengaturan berhasil disimpan.', 'success');
        })
        .catch(function (err) { App.toast(err.message, 'error'); })
        .then(function () { btn.disabled = false; btn.textContent = 'Simpan Perubahan'; });
    };
  }

  /* Field yang tidak ada di tab aktif dikembalikan `undefined`, lalu dibuang
     dari payload. Tanpa ini, checkbox tab lain terkirim `false` dan diam-diam
     mematikan pengaturan yang tidak sedang ditampilkan. */
  function getVal(root, sel) {
    var el = root.querySelector(sel);
    return el ? el.value : undefined;
  }
  function numVal(root, sel, def) {
    var v = getVal(root, sel);
    if (v === undefined) return undefined;
    if (v === '') return def;
    var n = Number(v);
    return isFinite(n) ? n : def;
  }
  function chkVal(root, sel) {
    var el = root.querySelector(sel);
    return el ? el.checked : undefined;
  }

  /** Nilai cadangan hanya dipakai bila fieldnya benar-benar ada di tab ini. */
  function orDefault(value, fallback) {
    if (value === undefined) return undefined;
    return value === '' ? fallback : value;
  }

  /** Buang key yang bernilai undefined supaya tidak menimpa nilai tersimpan. */
  function compact(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== undefined) out[k] = obj[k];
    });
    return out;
  }
})();
