/* =============================================================================
 * Halaman PENGGUNA & PENGATURAN
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  function escAttr(value) {
    return esc(value);
  }

  window.Pages = window.Pages || {};

  var users = [];
  var ROLES = [
    { key: 'admin', label: 'Administrator (akses penuh)' },
    { key: 'hr', label: 'HR (kelola karyawan & shift)' },
    { key: 'operator', label: 'Operator (absensi & perangkat)' },
    { key: 'viewer', label: 'Viewer (hanya lihat & unduh laporan)' },
    { key: 'employee', label: 'Karyawan (portal mandiri, data sendiri)' },
  ];

  var employees = [];

  // ============================================================ PENGGUNA

  window.Pages.users = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Akun Pengguna Aplikasi</h2>' +
          '<p class="card-subtitle">Akun dipakai untuk masuk ke sistem, terpisah dari data karyawan</p></div>' +
          '<div class="btn-group">' +
            '<button class="btn primary" id="userAdd">+ Tambah Akun</button>' +
            '<button class="btn" id="userReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body tight" id="userTable">' + App.loading('Memuat akun...') + '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header"><div><h2 class="card-title">Peran & Hak Akses</h2></div></div>' +
        '<div class="card-body tight">' + App.table([
          { key: 'label', label: 'Peran' },
          { key: 'desc', label: 'Kemampuan' },
        ], [
          { label: 'Administrator', desc: 'Akses penuh termasuk hapus karyawan, kelola mesin, dan kelola akun pengguna.' },
          { label: 'HR', desc: 'Kelola karyawan, shift, jadwal, izin, koreksi rekap, dan kirim notifikasi.' },
          { label: 'Operator', desc: 'Lihat absensi, jalankan sinkronisasi mesin, tambah log manual, dan koreksi rekap.' },
          { label: 'Viewer', desc: 'Hanya melihat dashboard, absensi, dan mengunduh laporan.' },
          { label: 'Karyawan', desc: 'Hanya membuka Portal Saya: rekap kehadiran sendiri, pengajuan izin/cuti, dan check-in dinas luar kota.' },
        ], { empty: '' }) + '</div>' +
      '</div>';

    document.getElementById('userAdd').addEventListener('click', function () { openUserForm(null); });
    document.getElementById('userReload').addEventListener('click', load);

    document.getElementById('userTable').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      var act = btn.getAttribute('data-act');
      var user = users.find(function (u) { return u.id === id; });
      if (!user) return;
      if (act === 'edit') openUserForm(user);
      else if (act === 'toggle') doToggle(user);
    });

    load();
  };

  function load() {
    var box = document.getElementById('userTable');
    box.innerHTML = App.loading('Memuat akun...');

    api.get('/auth/users')
      .then(function (res) {
        users = res.data || [];
        paint();
        return loadEmployeeOptions();
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  /** Daftar karyawan untuk dipilih saat membuat akun role employee. */
  function loadEmployeeOptions() {
    return api
      .get('/employees', { per_page: 500, status: 'aktif' })
      .then(function (res) {
        employees = res.data || [];
      })
      .catch(function () {
        employees = [];
      });
  }

  function employeeOptions(selectedId) {
    var options = employees.map(function (e) {
      return (
        '<option value="' + e.id + '"' +
        (Number(selectedId) === Number(e.id) ? ' selected' : '') +
        '>' + esc(e.employee_code + ' - ' + e.name) + '</option>'
      );
    });
    return options.join('');
  }

  function paint() {
    var box = document.getElementById('userTable');
    var currentId = App.state.user && App.state.user.id;

    var columns = [
      { key: 'username', label: 'Username', mono: true },
      { key: 'full_name', label: 'Nama Lengkap' },
      { key: 'role', label: 'Peran', render: function (r) {
        var map = { admin: 'danger', hr: 'info', operator: 'warning', viewer: 'idle', employee: 'dinas_luar' };
        return '<span class="badge ' + (map[r.role] || 'idle') + '">' + esc(r.role) + '</span>';
      } },
      { key: 'employee_name', label: 'Data Karyawan', render: function (r) {
        return r.employee_name
          ? esc(r.employee_code + ' - ' + r.employee_name)
          : '<span class="faint">-</span>';
      } },
      { key: 'is_active', label: 'Status', render: function (r) {
        return Number(r.is_active) === 1
          ? '<span class="badge success">Aktif</span>'
          : '<span class="badge failed">Nonaktif</span>';
      } },
      { key: 'last_login_at', label: 'Login Terakhir', render: function (r) {
        return r.last_login_at ? '<span class="small">' + esc(App.fmtRelative(r.last_login_at)) + '</span>' : '<span class="faint">belum pernah</span>';
      } },
      { key: 'created_at', label: 'Dibuat', render: function (r) {
        return '<span class="small faint">' + esc(App.fmtDate(r.created_at)) + '</span>';
      } },
      { key: 'aksi', label: 'Aksi', width: '190px', render: function (r) {
        if (r.id === currentId) return '<span class="small faint">akun Anda</span>';
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' +
          '<button class="btn sm ' + (Number(r.is_active) === 1 ? 'danger' : 'success') + '" data-act="toggle" data-id="' + r.id + '">' +
            (Number(r.is_active) === 1 ? 'Nonaktifkan' : 'Aktifkan') +
          '</button>' +
        '</div>';
      } },
    ];

    box.innerHTML = App.table(columns, users, { empty: 'Belum ada akun.', emptyIcon: '&#128100;' });
  }

  function openUserForm(user) {
    var isEdit = Boolean(user);
    var minLength = 8;

    App.modal({
      title: isEdit ? 'Ubah Akun: ' + user.username : 'Tambah Akun Pengguna',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field" style="grid-column:1/-1"><label>Peran <span class="req">*</span></label><select id="uRole">' +
            ROLES.map(function (r) {
              return '<option value="' + r.key + '"' + (isEdit && user.role === r.key ? ' selected' : '') + '>' + esc(r.label) + '</option>';
            }).join('') +
          '</select></div>' +
          '<div class="field" id="uEmpField" style="grid-column:1/-1"' + (isEdit && user.role !== 'employee' ? ' hidden' : '') + '>' +
            '<label>Data Karyawan <span class="req">*</span></label>' +
            '<select id="uEmployee"><option value="">-- Pilih karyawan --</option>' +
              employeeOptions(isEdit ? user.employee_id : null) +
            '</select>' +
            '<span class="help">Satu karyawan hanya boleh punya satu akun portal.</span>' +
          '</div>' +
          '<div class="callout" id="uEmpHint" style="grid-column:1/-1"' +
            (isEdit && user.role !== 'employee' ? ' hidden' : '') +
          '>Peran Karyawan hanya melihat data miliknya sendiri di Portal Saya.</div>' +
          '<div class="field"><label>Username <span class="req">*</span></label>' +
            '<input type="text" id="uName" value="' + esc(isEdit ? user.username : '') + '"' + (isEdit ? ' disabled' : '') + '>' +
            (isEdit ? '<span class="help">Username tidak dapat diubah.</span>' : '') +
          '</div>' +
          '<div class="field"><label>Nama Lengkap <span class="req">*</span></label>' +
            '<input type="text" id="uFull" value="' + esc(isEdit ? user.full_name : '') + '"></div>' +
          '<div class="field" style="grid-column:1/-1"><label>' + (isEdit ? 'Password Baru' : 'Password <span class="req">*</span>') + '</label>' +
            '<input type="password" id="uPass" autocomplete="new-password" placeholder="Minimal ' + minLength + ' karakter">' +
            (isEdit ? '<span class="help">Kosongkan bila tidak ingin mengubah password.</span>' : '') +
          '</div>' +
        '</div>' +
        (isEdit ? '<div class="field checkbox mt"><input type="checkbox" id="uActive"' + (Number(user.is_active) === 1 ? ' checked' : '') + '>' +
          '<label for="uActive">Akun aktif</label></div>' : ''),
onMount: function (modalEl) {
        var role = modalEl.querySelector('#uRole');
        var field = modalEl.querySelector('#uEmpField');
        var hint = modalEl.querySelector('#uEmpHint');
        var employeeSelect = modalEl.querySelector('#uEmployee');
        var fullName = modalEl.querySelector('#uFull');
        var username = modalEl.querySelector('#uName');

        function findEmployee(id) {
          for (var i = 0; i < employees.length; i += 1) {
            if (Number(employees[i].id) === Number(id)) return employees[i];
          }
          return null;
        }

        // Nama lengkap dan username terisi otomatis dari karyawan yang dipilih,
        // selama kedua kolom itu belum diketik sendiri oleh pengguna.
        function fillFromEmployee() {
          var emp = findEmployee(employeeSelect.value);
          if (!emp) return;
          if (!username.value.trim()) username.value = emp.employee_code;
          if (!fullName.value.trim()) fullName.value = emp.name;
        }

        function sync() {
          var isEmployee = role.value === 'employee';
          field.hidden = !isEmployee;
          if (hint) hint.hidden = !isEmployee;
          if (isEmployee) fillFromEmployee();
        }

        role.addEventListener('change', sync);
        employeeSelect.addEventListener('change', fillFromEmployee);
        sync();
      },
      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Simpan Akun',
          className: 'primary',
          onClick: function (el) {
            var fullName = el.querySelector('#uFull').value.trim();
            var role = el.querySelector('#uRole').value;
            var password = el.querySelector('#uPass').value;
            var employeeId = el.querySelector('#uEmployee').value;

            if (!fullName) { App.toast('Nama lengkap wajib diisi.', 'error'); return false; }
            if (!isEdit && password.length < minLength) { App.toast('Password minimal ' + minLength + ' karakter.', 'error'); return false; }
            if (isEdit && password && password.length < minLength) { App.toast('Password minimal ' + minLength + ' karakter.', 'error'); return false; }

            if (role === 'employee' && !employeeId) {
              App.toast('Pilih data karyawan untuk peran Karyawan.', 'error');
              return false;
            }

            var payload = { full_name: fullName, role: role };
            if (role === 'employee') {
              payload.employee_id = Number(employeeId);
            } else {
              // Non-karyawan tidak boleh tertaut ke data karyawan.
              payload.employee_id = null;
            }
            if (password) payload.password = password;
            if (isEdit) payload.is_active = el.querySelector('#uActive').checked ? 1 : 0;

            var request = isEdit
              ? api.put('/auth/users/' + user.id, payload)
              : api.post('/auth/users', {
                  username: el.querySelector('#uName').value.trim(),
                  full_name: fullName,
                  role: role,
                  employee_id: role === 'employee' ? Number(employeeId) : null,
                  password: password,
                });

            request
              .then(function () {
                App.toast(isEdit ? 'Akun diperbarui.' : 'Akun dibuat.', 'success');
                el.closeModal();
                load();
              })
              .catch(function (err) {
                App.toast(err.message, 'error');
                return false;
              });
            return false;
          },
        },
      ],
    });
  }

  function doToggle(user) {
    var next = Number(user.is_active) === 1 ? 0 : 1;
    App.confirm({
      title: next === 1 ? 'Aktifkan akun' : 'Nonaktifkan akun',
      heading: (next === 1 ? 'Aktifkan ' : 'Nonaktifkan ') + user.full_name + '?',
      message: next === 1 ? 'Akun bisa masuk kembali ke sistem.' : 'Akun tidak akan bisa masuk. Sesi yang sedang berjalan akan ditolak.',
      danger: next === 0,
      confirmLabel: next === 1 ? 'Aktifkan' : 'Nonaktifkan',
      onConfirm: function () {
        api.put('/auth/users/' + user.id, { is_active: next })
          .then(function () {
            App.toast('Status akun diperbarui.', 'success');
            load();
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  // ============================================================ PENGATURAN

  // Tab "Status Sistem" dipakai ulang oleh halaman Pengaturan (pages/settings.js).
  window.Pages.settingsStatus = function (root, appSettings) {
    root.innerHTML = App.loading('Memuat pengaturan...');

    Promise.all([
      api.get('/devices/protocols'),
      api.get('/attendance/notify/status'),
      api.get('/devices/status'),
    ]).then(function (res) {
      var push = res[0].data || {};
      var notify = res[1].data || {};
      var sync = res[2].data || {};
      var tz = (appSettings && appSettings.timezone) || 'Asia/Jakarta';
      var lastCycle = sync.last_cycle || sync.lastCycle || {};
      var lastRun = sync.last_run_at || lastCycle.started_at || lastCycle.startedAt;
      var lastDone = sync.last_finished_at || lastCycle.finished_at || lastCycle.finishedAt;
      var totalRuns = sync.total_runs !== undefined ? sync.total_runs : sync.cycle_count;

      root.innerHTML =
        '<div class="grid-2">' +

          '<div class="card">' +
            '<div class="card-header"><div><h2 class="card-title">Server &amp; Jaringan</h2>' +
            '<p class="card-subtitle">Informasi koneksi untuk mesin fingerprint</p></div></div>' +
            '<div class="card-body">' +
              App.table([{ key: 'label', label: 'Konfigurasi' }, { key: 'value', label: 'Nilai' }], [
                { label: 'Alamat Server (untuk mesin PUSH)', value: (push.push && push.push.server_address_hint) || '-' },
                { label: 'Port PUSH / ADMS', value: (push.push && push.push.port) || '-' },
                { label: 'Autentikasi PUSH', value: (push.push && push.push.auth_token_required) ? 'Diaktifkan (token wajib)' : 'Tidak ada (batasi akses jaringan)' },
              ], { empty: '-' }) +
              '<div class="callout mt"><strong>Mode mesin fingerprint yang didukung</strong>' +
              '<strong>1. TCP (Polling)</strong> Aplikasi yang connects ke mesin pada port 4370 lalu menarik log secara berkala. Cocok untuk mesin yang hanya bisa dikonfigurasi mode "Ethernet / Standalone SDK".<br>' +
              '<strong>2. PUSH / ADMS</strong> Mesin yang mengirim log ke server secara otomatis. Cocok untuk menu "Comm / ADMS / Cloud Server".<br>' +
              '<strong>3. Impor File</strong> Unduh log dari software vendor (Excel/CSV), lalu impor lewat menu Perangkat.</div>' +
            '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-header"><div><h2 class="card-title">Sinkronisasi Otomatis</h2>' +
            '<p class="card-subtitle">Status penjadwal di server</p></div></div>' +
            '<div class="card-body">' +
              App.table([{ key: 'label', label: 'Informasi' }, { key: 'value', label: 'Nilai', render: function (r) { return r.value; } }], [
                { label: 'Status', value: sync.enabled ? '<span class="badge success">Aktif</span>' : '<span class="badge idle">Tidak aktif</span>' },
                { label: 'Periode', value: sync.interval_minutes ? 'Setiap ' + sync.interval_minutes + ' menit' : '-' },
                { label: 'Terakhir berjalan', value: lastRun ? App.fmtRelative(lastRun) : 'belum pernah' },
                { label: 'Selesai terakhir', value: lastDone ? App.fmtRelative(lastDone) : '-' },
                { label: 'Total siklus', value: App.formatNumber(totalRuns || 0) },
              ], { empty: 'Informasi penjadwal tidak tersedia.' }) +
              '<div class="callout success mt"><strong>Sinkronisasi berjalan di server</strong>' +
              'Tidak perlu membuka browser. Selama proses Node.js berjalan, mesin ditarik log secara otomatis. ' +
              'Interval diatur lewat variabel <code>SYNC_INTERVAL_MINUTES</code> di berkas <code>.env</code>.</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Notifikasi WhatsApp &amp; Email</h2>' +
          '<p class="card-subtitle">Status konfigurasi kanal pesan</p></div>' +
          (App.can('notify:send') ? '<div class="btn-group">' +
            '<button class="btn" id="setTestWa">Kirim Uji WhatsApp</button>' +
            '<button class="btn" id="setTestMail">Kirim Uji Email</button>' +
            '<button class="btn primary" id="setMonthly">Kirim Laporan Bulanan</button>' +
          '</div>' : '') +
          '</div>' +
          '<div class="card-body tight">' +
            App.table([
              { key: 'label', label: 'Kanal' },
              { key: 'enabled', label: 'Status', render: function (r) {
                if (!r.enabled) return '<span class="badge idle">Nonaktif</span>';
                return r.detail
                  ? '<span class="badge warning">Belum lengkap</span>'
                  : '<span class="badge success">Aktif</span>';
              } },
              { key: 'detail', label: 'Keterangan' },
            ], [
              {
                label: 'Email (SMTP)',
                enabled: notify.email && notify.email.enabled,
                detail: (notify.email && notify.email.problem) ||
                  (notify.email && notify.email.host ? notify.email.host + ':' + notify.email.port : ''),
              },
              {
                label: 'WhatsApp',
                enabled: notify.whatsapp && notify.whatsapp.enabled,
                detail: (notify.whatsapp && notify.whatsapp.problem) ||
                  (notify.whatsapp && notify.whatsapp.gateway ? notify.whatsapp.gateway : ''),
              },
            ], { empty: 'Konfigurasi kanal notifikasi tidak terbaca.' }) +
          '</div>' +
          '<div class="card-body" style="border-top:1px solid var(--border)">' +
            '<div class="callout"><strong>Isi pengaturan di halaman ini</strong>' +
            'Kanal WhatsApp dan Email diatur pada tab <strong>Notifikasi</strong> di halaman Pengaturan, ' +
            'lalu klik Simpan. Perubahan langsung berlaku tanpa restart server. ' +
            'Bila kolomnya masih kosong, sistem memakai nilai bawaan dari berkas <code>.env</code>.</div>' +
            '<div class="callout warning"><strong>Catatan WhatsApp</strong>' +
            'Dua pilihan: <strong>Nomor sendiri (scan QR)</strong> — kirim dari HP sendiri tanpa gateway, ' +
            'atau <strong>Gateway</strong> seperti Fonnte/Wablas. Nomor sendiri yang gagal otomatis lewat gateway bila gateway terisi.</div>' +
            '<div class="callout"><strong>Catatan Email</strong>' +
            'Untuk Gmail, buat App Password di pengaturan keamanan akun Google, lalu pakai sebagai password SMTP. ' +
            'Status di atas membaca konfigurasi yang benar-benar dipakai saat mengirim.</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Jejak Audit</h2>' +
          '<p class="card-subtitle">Siapa mengubah apa di data sensitif</p></div>' +
          (App.can('audit:read') ? '<div class="btn-group">' +
            '<button class="btn" id="audRefresh">&#8635; Muat</button>' +
          '</div>' : '') +
          '</div>' +
          '<div class="card-body tight" id="audBox">' +
            (App.can('audit:read')
              ? App.loading('Memuat jejak audit...')
              : '<div class="empty-state">Jejak audit hanya bisa dilihat oleh Admin dan HR.</div>') +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Tentang Aplikasi</h2></div></div>' +
          '<div class="card-body">' +
            App.table([{ key: 'label', label: 'Komponen' }, { key: 'value', label: 'Versi' }], [
              { label: 'Aplikasi Absensi Fingerprint', value: '1.2.0' },
              { label: 'Node.js', value: '24.x' },
              { label: 'Database', value: 'MySQL / MariaDB' },
              { label: 'Zona waktu', value: esc(tz) },
            ], { empty: '-' }) +
          '</div>' +
        '</div>';

      bindSettings(push, notify);
      bindAudit();
    }).catch(function (err) {
      root.innerHTML = '<div class="card"><div class="empty-state">' +
        '<div class="big">&#9888;</div><div>Gagal memuat pengaturan: ' + esc(err.message) + '</div></div></div>';
    });
  };

  function bindSettings(push, notify) {
    var waBtn = document.getElementById('setTestWa');    if (waBtn) {
      waBtn.addEventListener('click', function () { sendDailyReminder('whatsapp', this); });
    }

    var mailBtn = document.getElementById('setTestMail');
    if (mailBtn) {
      mailBtn.addEventListener('click', function () { sendDailyReminder('email', this); });
    }

    var monthly = document.getElementById('setMonthly');
    if (monthly) {
      monthly.addEventListener('click', function () {
        App.modal({
          title: 'Kirim Laporan Bulanan',
          bodyHtml:
            '<div class="callout">Laporan dikirim ke seluruh karyawan yang memiliki WhatsApp atau email terdaftar.</div>' +
            '<div class="form-grid">' +
              '<div class="field"><label>Bulan <span class="req">*</span></label><input type="month" id="mrMonth" value="' + esc(App.today().slice(0, 7)) + '"></div>' +
            '</div>',
          actions: [
            { label: 'Batal' },
            {
              label: 'Kirim',
              className: 'primary',
              onClick: function (el) {
                var month = el.querySelector('#mrMonth').value;
                if (!/^\d{4}-\d{2}$/.test(month)) { App.toast('Bulan tidak valid.', 'error'); return false; }

                api.post('/attendance/notify/monthly-report', { month: month })
                  .then(function (res) {
                    var d = res.data || {};
                    App.toast('Laporan ' + App.monthLabel(month) + ' dikirim. Berhasil: ' + App.formatNumber(d.sent || 0) + ', gagal: ' + App.formatNumber(d.failed || 0) + '.', 'success');
                    el.closeModal();
                  })
                  .catch(function (err) { App.toast(err.message, 'error'); return false; });
                return false;
              },
            },
          ],
        });
      });
    }

    void push;
    void notify;
  }

  // ------------------------------------------------------------- Jejak audit

  var audPage = 1;

  function bindAudit() {
    if (!App.can('audit:read')) return;

    var refresh = document.getElementById('audRefresh');
    if (refresh) refresh.addEventListener('click', function () { audPage = 1; loadAudit(); });

    loadAudit();
  }

  /** Muat jejak audit ke kartu "Jejak Audit". */
  function loadAudit() {
    var box = document.getElementById('audBox');
    if (!box || !App.can('audit:read')) return;

    box.innerHTML = App.loading('Memuat jejak audit...');

    api.get('/audit', { per_page: 10, page: audPage })
      .then(function (res) {
        var rows = res.rows || [];
        var meta_ = res.meta || {};

        if (rows.length === 0) {
          box.innerHTML = '<div class="empty-state"><div class="big">&#128203;</div>' +
            '<div>Belum ada jejak audit. Perubahan data akan tercatat di sini.</div></div>';
          return;
        }

        box.innerHTML = App.table([
          { key: 'created_at', label: 'Waktu', render: function (r) {
            return '<span title="' + escAttr(String(r.created_at || '')) + '">' +
              esc(App.fmtDateTime(r.created_at)) + '</span>';
          } },
          { key: 'actor', label: 'Pelaku', render: function (r) {
            return r.actor ? esc(r.actor) : '<span class="faint">-</span>';
          } },
          { key: 'action', label: 'Aksi', render: function (r) {
            return '<span class="badge ' + auditBadge(r.action) + '">' + esc(auditLabel(r.action)) + '</span>';
          } },
          { key: 'entity', label: 'Objek', render: function (r) {
            if (!r.entity) return '<span class="faint">-</span>';
            return '<span class="small">' + esc(r.entity) +
              (r.entity_id ? ' <span class="faint">#' + esc(r.entity_id) + '</span>' : '') + '</span>';
          } },
          { key: 'detail', label: 'Keterangan', render: function (r) {
            var text = summarizeAuditDetail(r.detail);
            if (!text) return '<span class="faint">-</span>';
            return '<span class="small" title="' + escAttr(text) + '">' + esc(text.slice(0, 90)) +
              (text.length > 90 ? '...' : '') + '</span>';
          } },
          { key: 'ip_address', label: 'IP', render: function (r) {
            return r.ip_address ? '<span class="mono small">' + esc(r.ip_address) + '</span>' : '<span class="faint">-</span>';
          } },
        ], rows, { empty: '-' }) +
        '<div class="pagination">' +
          '<span>' + App.formatNumber(meta_.total || 0) + ' jejak | Halaman ' + (meta_.page || 1) +
            ' dari ' + (meta_.total_pages || 1) + '</span>' +
          '<button class="btn sm" data-pg="prev"' + ((meta_.page || 1) <= 1 ? ' disabled' : '') + '>&laquo; Sebelumnya</button>' +
          '<button class="btn sm" data-pg="next"' + ((meta_.page || 1) >= (meta_.total_pages || 1) ? ' disabled' : '') + '>Berikutnya &raquo;</button>' +
        '</div>';

        box.querySelectorAll('button[data-pg]').forEach(function (b) {
          b.addEventListener('click', function () {
            audPage = b.getAttribute('data-pg') === 'next' ? (meta_.page || 1) + 1 : (meta_.page || 1) - 1;
            loadAudit();
          });
        });
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div>' +
          '<div>Gagal memuat jejak audit: ' + esc(err.message) + '</div></div>';
      });
  }

  var AUDIT_LABELS = {
    'auth.login': 'Login berhasil',
    'auth.login_failed': 'Login gagal',
    'auth.login_locked': 'Akun terkunci',
    'auth.login_throttled': 'Login ditunda',
    'auth.password_change': 'Ganti password',
    'user.create': 'Buat pengguna',
    'user.update': 'Ubah pengguna',
    'attendance.override': 'Koreksi rekap',
    'attendance.override_reset': 'Batalkan koreksi',
    'attendance.manual_log': 'Log manual',
    'leave.review': 'Review pengajuan',
    'reimburse.review': 'Review reimburse',
    'leave_quota.reset': 'Reset jatah cuti',
    'employee.create': 'Buat karyawan',
    'employee.update': 'Ubah karyawan',
    'employee.delete': 'Hapus karyawan',
    'employee.archive': 'Arsipkan karyawan',
    'shift.create': 'Buat shift',
    'shift.update': 'Ubah shift',
    'shift.delete': 'Hapus shift',
    'settings.update': 'Ubah pengaturan',
  };

  function auditLabel(action) {
    return AUDIT_LABELS[action] || String(action || '-');
  }

  function auditBadge(action) {
    if (/delete|hapus|archive/i.test(action)) return 'failed';
    if (/failed|gagal|locked|throttled/i.test(action)) return 'warning';
    if (/create|login|tambah/i.test(action)) return 'success';
    if (/update|ubah|override|review|reset/i.test(action)) return 'info';
    return 'idle';
  }

  /**
   * Ringkas kolom detail JSON jadi satu baris-teks yang enak dibaca.
   * Kalau isinya "changes", tampilkan "field: lama -> baru" per field.
   */
  function summarizeAuditDetail(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;

    var data;
    try {
      data = typeof detail === 'object' ? detail : JSON.parse(detail);
    } catch (e) {
      return String(detail);
    }
    if (!data || typeof data !== 'object') return String(detail);

    if (data.changes && typeof data.changes === 'object') {
      return Object.keys(data.changes).map(function (key) {
        var c = data.changes[key] || {};
        var from = c.from === null || c.from === undefined || c.from === '' ? '(kosong)' : String(c.from);
        var to = c.to === null || c.to === undefined || c.to === '' ? '(kosong)' : String(c.to);
        return key + ': ' + from + ' -> ' + to;
      }).join('; ');
    }

    return Object.keys(data).map(function (key) {
      var v = data[key];
      if (v === null || v === undefined) return '';
      return key + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v));
    }).filter(Boolean).join(', ');
  }

  function sendDailyReminder(channel, btn) {
    App.modal({
      title: 'Kirim Pengingat Harian',
      bodyHtml:
        '<div class="callout">Pilih satu karyawan untuk uji coba pesan ' + (channel === 'whatsapp' ? 'WhatsApp' : 'email') + '.</div>' +
        '<div class="field"><label>Karyawan</label><select id="ntEmp"><option value="">- pilih -</option></select></div>' +
        '<div class="field mt"><label>Tanggal</label><input type="date" id="ntDate" value="' + esc(App.today()) + '"></div>',
      actions: [{ label: 'Tutup' }],
      onMount: function (el) {
        api.get('/employees/options/list').then(function (res) {
          var sel = el.querySelector('#ntEmp');
          (res.data || []).forEach(function (e) {
            var opt = document.createElement('option');
            opt.value = e.id;
            opt.textContent = e.employee_code + ' - ' + e.name + (e.phone ? ' (' + e.phone + ')' : (e.email ? ' (' + e.email + ')' : ' tanpa kontak'));
            sel.appendChild(opt);
          });
        }).catch(function () {});

        var run = el.querySelector('#ntEmp');
        var sendBtn = document.createElement('button');
        sendBtn.className = 'btn primary mt';
        sendBtn.textContent = 'Kirim Pengingat';
        sendBtn.addEventListener('click', function () {
          var id = run.value;
          if (!id) { App.toast('Pilih karyawan.', 'error'); return; }
          sendBtn.disabled = true;
          sendBtn.innerHTML = '<span class="spinner"></span> Mengirim...';

          api.post('/attendance/notify/daily', {
            employee_id: Number(id),
            date: el.querySelector('#ntDate').value,
          })
            .then(function (res) {
              var d = res.data || {};
              App.toast('Pesan dikirim ke ' + (d.to || '-') + '.', d.ok === false ? 'warning' : 'success');
              if (d.ok === false && d.message) App.toast(d.message, 'error', 8000);
            })
            .catch(function (err) { App.toast(err.message, 'error'); })
            .then(function () {
              sendBtn.disabled = false;
              sendBtn.textContent = 'Kirim Pengingat';
            });
        });
        el.appendChild(sendBtn);
      },
    });

    void btn;
  }
})();
