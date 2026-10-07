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
        else paintSystem(box, cached);
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

  function toBool(v, def) {
    if (v === undefined || v === null || v === '') return Boolean(def);
    if (v === true || v === 1) return true;
    if (!v) return false;
    return ['1', 'true', 'yes', 'on', 'ya'].indexOf(String(v).toLowerCase()) >= 0;
  }

  var DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

  /**
   * Pemilih hari kerja (1..7 = Senin..Minggu, sama seperti shifts.work_days).
   * Nilai disimpan sebagai input tersembunyi "1,2,3,4,5" agar cocok dengan
   * kolom work_days di tabel shifts.
   */
  function workDaysField(value) {
    var selected = String(value || '1,2,3,4,5')
      .split(',')
      .map(function (v) { return Number(v.trim()); })
      .filter(function (v) { return v >= 1 && v <= 7; });
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
      '<span class="help">Hari yang tidak dicentang tidak dihitung sebagai hari kerja (tidak menambah persentase kehadiran, tidak menambah alpa).</span>' +
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
            '<div class="field checkbox full"><input type="checkbox" id="sync_enabled"' + (toBool(s.sync_enabled) ? ' checked' : '') + '><label for="sync_enabled">Nyalakan Auto-sync (MATI = UI tidak macet)</label></div>' +
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
          '<div class="card-header"><div><h2 class="card-title">WhatsApp</h2><p class="card-subtitle">Nomor sendiri (scan QR) atau gateway</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field checkbox full"><input type="checkbox" id="whatsapp_enabled"' + (toBool(s.whatsapp_enabled) ? ' checked' : '') + '><label for="whatsapp_enabled">Aktifkan WhatsApp</label></div>' +
              '<div class="field"><label for="whatsapp_provider">Provider</label><select id="whatsapp_provider">' +
                '<option value="self"' + ((s.whatsapp_provider || 'gateway') === 'self' ? ' selected' : '') + '>Nomor sendiri (scan QR)</option>' +
                '<option value="gateway"' + ((s.whatsapp_provider || 'gateway') !== 'self' ? ' selected' : '') + '>Gateway (Fonnte/Wablas/custom)</option>' +
              '</select><span class="help">Nomor sendiri = kirim dari HP sendiri, tanpa biaya gateway.</span></div>' +
              '<div class="field checkbox full"><input type="checkbox" id="whatsapp_self_autostart"' + (toBool(s.whatsapp_self_autostart, true) ? ' checked' : '') + '><label for="whatsapp_self_autostart">Sambungkan otomatis saat server nyala (provider nomor sendiri)</label></div>' +
              '<div id="waGatewayFields" style="display:contents">' +
              field('URL Gateway', 'whatsapp_url', s.whatsapp_url, 'url', 'https://api.fonnte.com/send', '', '', 'Contoh: https://api.fonnte.com/send. Hanya provider Gateway. Jadi cadangan bila nomor sendiri gagal.') +
              field('Token/Bearer', 'whatsapp_token', s.whatsapp_token, 'password', 'isi-token-gateway-disini') +
              '</div>' +
              field('Nomor Penerima Default', 'whatsapp_target', s.whatsapp_target, 'text', '62812xxxxxxx, 62813xxxxxxx', '', '', 'Bisa banyak, pisahkan koma untuk broadcast. Contoh: 62812xxxxxxx, 62813xxxxxxx. Ini nomor TUJUAN, bukan pengirim — pengirim = HP yang scan QR.') +
              '<div class="field"><label>&nbsp;</label><button type="button" class="btn sm" id="waPickEmp">Pilih dari karyawan</button><span class="help">Ambil nomor HP dari data karyawan.</span></div>' +
              field('Field Target (JSON)', 'whatsapp_field_target', s.whatsapp_field_target, 'text', 'target', '', '', 'Contoh Fonnte: target. Contoh Wablas: phone.') +
              field('Field Pesan (JSON)', 'whatsapp_field_message', s.whatsapp_field_message, 'text', 'message', '', '', 'Contoh Fonnte: message. Contoh Wablas: message.') +
              field('Jeda WA min (ms)', 'whatsapp_self_min_delay_ms', s.whatsapp_self_min_delay_ms, 'number', '', '1000', '60000', 'Jeda acak antar pesan. Makin besar makin aman dari banned.') +
              field('Jeda WA maks (ms)', 'whatsapp_self_max_delay_ms', s.whatsapp_self_max_delay_ms, 'number', '', '1000', '120000') +
              field('Maks WA / menit', 'whatsapp_self_per_minute', s.whatsapp_self_per_minute, 'number', '', '1', '60') +
              field('Maks WA / hari', 'whatsapp_self_daily_limit', s.whatsapp_self_daily_limit, 'number', '', '10', '5000') +
            '</div>' +
            '<div id="waSelfBox" style="margin-top:12px"></div>' +
            '<div class="callout mt"><strong>Nomor sendiri (anti-banned)</strong> ' +
              'Klik Simpan dulu, lalu klik "Hubungkan" dan scan QR dari WhatsApp HP (Perangkat Tertaut). ' +
              'Kirim massal otomatis antre FIFO + jeda acak + batas per menit/hari. ' +
              'Sesi tersimpan di server, scan cukup sekali sampai logout. Bila nomor sendiri gagal tapi gateway terisi, kirim otomatis lewat gateway.</div>' +
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
    bindWaSelf();
    bindWaPickEmp();
    toggleWaGateway();
    var providerSel = document.getElementById('whatsapp_provider');
    if (providerSel) providerSel.addEventListener('change', toggleWaGateway);
  }

  function bindWaPickEmp() {
    var btn = document.getElementById('waPickEmp');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var targetInput = document.getElementById('whatsapp_target');
      var existing = targetInput ? targetInput.value : '';
      var picked = {};
      existing.split(/[,;\n]+/).forEach(function (p) {
        var t = p.trim();
        if (t) picked[t] = true;
      });
      App.modal({
        title: 'Pilih Nomor Karyawan',
        bodyHtml:
          '<div class="field"><label>Cari</label><input type="text" id="waEmpSearch" placeholder="Nama / kode..."></div>' +
          '<div id="waEmpList">' + App.loading('Memuat karyawan...') + '</div>',
        actions: [
          { label: 'Batal' },
          { label: 'Pakai Nomor Ini', className: 'primary', value: 'use' },
        ],
        onAction: function (value, el) {
          if (value !== 'use') return true;
          el.querySelectorAll('.waEmp:checked').forEach(function (cb) {
            if (cb.value) picked[cb.value] = true;
          });
          var merged = Object.keys(picked).join(', ');
          if (targetInput) targetInput.value = merged;
          if (!App.can('settings:write')) {
            App.toast(Object.keys(picked).length + ' nomor dipilih. Klik Simpan butuh admin.', 'warning');
            return true;
          }
          api.put('/settings', { whatsapp_target: merged })
            .then(function () { App.toast(Object.keys(picked).length + ' nomor disimpan.', 'success'); })
            .catch(function (err) { App.toast('Nomor dipilih, tapi gagal simpan: ' + err.message, 'error'); });
          return true;
        },
        onMount: function (el) {
          var list = [];
          var box = el.querySelector('#waEmpList');
          function paint(filter) {
            var q = String(filter || '').toLowerCase();
            var show = list.filter(function (e) {
              if (!q) return true;
              return (e.name + ' ' + e.employee_code).toLowerCase().indexOf(q) >= 0;
            });
            box.innerHTML = show.length === 0
              ? '<div class="empty-state">Tidak ada karyawan cocok / bernomor HP.</div>'
              : show.map(function (e) {
                  var checked = picked[e.phone] ? ' checked' : '';
                  return '<label class="row" style="gap:8px;padding:4px 0">' +
                    '<input type="checkbox" class="waEmp" value="' + esc(e.phone) + '"' + checked + '>' +
                    '<span>' + esc(e.employee_code + ' - ' + e.name) + ' <span class="faint">' + esc(e.phone) + '</span></span>' +
                  '</label>';
                }).join('');
          }
          el.querySelector('#waEmpSearch').addEventListener('input', function () { paint(this.value); });
          api.get('/employees/options/list')
            .then(function (res) {
              var rows = res.data || [];
              if (rows.length > 0 && !rows[0].phone) {
                box.innerHTML = '<div class="empty-state">Server belum membawa nomor HP.<br>Restart server (<code>npm run dev</code>) lalu buka lagi.</div>';
                return;
              }
              list = rows.filter(function (e) { return e.phone; });
              paint('');
            })
            .catch(function (err) { box.innerHTML = '<div class="empty-state">Gagal memuat: ' + esc(err.message) + '</div>'; });
        },
      });
    });
  }

  function toggleWaGateway() {
    var sel = document.getElementById('whatsapp_provider');
    var wrap = document.getElementById('waGatewayFields');
    if (!sel || !wrap) return;
    wrap.style.display = sel.value === 'self' ? 'none' : 'contents';
  }

  var waSelfTimer = null;

  function bindWaSelf() {
    if (waSelfTimer) { clearInterval(waSelfTimer); waSelfTimer = null; }
    var box = document.getElementById('waSelfBox');
    if (!box) return;
    if (!App.can('notify:send')) {
      box.innerHTML = '<div class="callout">Status WhatsApp nomor sendiri hanya untuk Admin/HR.</div>';
      return;
    }
    loadWaSelf();
    waSelfTimer = setInterval(function () {
      if (!document.getElementById('waSelfBox')) {
        clearInterval(waSelfTimer);
        waSelfTimer = null;
        return;
      }
      loadWaSelf(true);
    }, 5000);
  }

  function loadWaSelf(quiet) {
    var box = document.getElementById('waSelfBox');
    if (!box) return;
    if (!quiet) box.innerHTML = App.loading('Memuat status WhatsApp...');
    api.get('/whatsapp/self/status')
      .then(function (res) { paintWaSelf(res.data || {}); })
      .catch(function (err) {
        if (!quiet) box.innerHTML = '<div class="callout warning">Status WA gagal dimuat: ' + esc(err.message) + '</div>';
      });
  }

  function paintWaSelf(st) {
    var box = document.getElementById('waSelfBox');
    if (!box) return;
    var badge = st.ready
      ? '<span class="badge success">Terhubung' + (st.phone ? ' +' + esc(st.phone) : '') + '</span>'
      : st.state === 'qr'
        ? '<span class="badge warning">Menunggu scan QR</span>'
        : '<span class="badge idle">' + esc(st.state || 'belum terhubung') + '</span>';
    var q = st.queue || {};
    var html = '<div class="callout"><strong>Nomor sendiri</strong> ' + badge +
      (st.lastError ? '<div class="small" style="margin-top:4px">Catatan: ' + esc(st.lastError) + '</div>' : '') +
      '<div class="small faint" style="margin-top:4px">Antrean: ' + (q.queued || 0) + ' menunggu | ' +
        (q.sentLastMinute || 0) + '/' + (st.perMinute || '-') + '/menit | ' +
        (q.sentToday || 0) + '/' + (st.dailyLimit || '-') + '/hari | jeda ' +
        (st.minDelayMs || '-') + '-' + (st.maxDelayMs || '-') + ' ms</div></div>';

    if (st.qrDataUrl) {
      html += '<div style="text-align:center;margin:8px 0">' +
        '<img src="' + st.qrDataUrl + '" alt="QR WhatsApp" style="width:280px;max-width:100%;border:1px solid var(--border);border-radius:8px">' +
        '<div class="small faint">Buka WhatsApp HP &gt; Perangkat Tertaut &gt; Tautkan Perangkat, lalu scan.</div></div>';
    }

    html += '<div class="row" style="margin-top:8px">' +
      '<button class="btn sm primary" id="waSelfStart">Hubungkan / Tampilkan QR</button>' +
      '<button class="btn sm" id="waSelfStop">Putuskan</button>' +
      '<button class="btn sm danger" id="waSelfLogout">Logout + hapus sesi</button>' +
      '<button class="btn sm" id="waSelfTest">Kirim uji</button>' +
    '</div>';

    if (st.provider && st.provider !== 'self') {
      html += '<div class="callout warning mt">Provider aktif masih <strong>Gateway</strong>. Pilih "Nomor sendiri", klik Simpan, lalu Hubungkan.</div>';
    }

    box.innerHTML = html;

    document.getElementById('waSelfStart').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      // Simpan dulu provider + centang aktif dari form, supaya klik Hubungkan
      // tidak gagal 500 karena settings tersimpan masih 'gateway'/mati.
      var providerEl = document.getElementById('whatsapp_provider');
      var enabledEl = document.getElementById('whatsapp_enabled');
      var savePayload = {};
      if (providerEl) savePayload.whatsapp_provider = providerEl.value;
      if (enabledEl) savePayload.whatsapp_enabled = enabledEl.checked;
      api.put('/settings', savePayload)
        .then(function () {
          if (providerEl) providerEl.value = 'self';
          return api.post('/whatsapp/self/start', {});
        })
        .then(function (res) { paintWaSelf(res.data || {}); App.toast('Sesi WhatsApp dimulai. Scan QR bila muncul.', 'success'); })
        .catch(function (err) { App.toast(err.message, 'error'); })
        .then(function () { btn.disabled = false; loadWaSelf(true); });
    });
    document.getElementById('waSelfStop').addEventListener('click', function () {
      api.post('/whatsapp/self/stop', {})
        .then(function (res) { paintWaSelf(res.data || {}); })
        .catch(function (err) { App.toast(err.message, 'error'); });
    });
    document.getElementById('waSelfLogout').addEventListener('click', function () {
      if (!confirm('Hapus sesi WhatsApp? HP perlu scan ulang.')) return;
      api.post('/whatsapp/self/logout', {})
        .then(function (res) { paintWaSelf(res.data || {}); })
        .catch(function (err) { App.toast(err.message, 'error'); });
    });
    document.getElementById('waSelfTest').addEventListener('click', function () {
      var target = (document.getElementById('whatsapp_target') || {}).value || '';
      if (!target) { App.toast('Isi Nomor Penerima Default dulu (nomor HP tujuan).', 'error'); return; }
      api.post('/whatsapp/self/test', { target: target })
        .then(function (res) {
          var d = res.data || {};
          App.toast(d.ok ? 'Pesan uji terkirim.' : ('Gagal: ' + (d.error || 'unknown')), d.ok ? 'success' : 'error');
        })
        .catch(function (err) { App.toast(err.message, 'error'); });
    });
  }

  function paintSystem(box, s) {
    if (window.Pages && typeof window.Pages.settingsStatus === 'function') {
      window.Pages.settingsStatus(box, s || cached);
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
        sync_enabled: chkVal(body, '#sync_enabled'),
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
        whatsapp_provider: getVal(body, '#whatsapp_provider'),
        whatsapp_self_autostart: chkVal(body, '#whatsapp_self_autostart'),
        whatsapp_self_min_delay_ms: numVal(body, '#whatsapp_self_min_delay_ms', 4000),
        whatsapp_self_max_delay_ms: numVal(body, '#whatsapp_self_max_delay_ms', 9000),
        whatsapp_self_per_minute: numVal(body, '#whatsapp_self_per_minute', 12),
        whatsapp_self_daily_limit: numVal(body, '#whatsapp_self_daily_limit', 300),
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
