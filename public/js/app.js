/* =============================================================================
 * APLIKASI ABSENSI FINGERPRINT - Bootstrap, Layout, Router
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  // ------------------------------------------------------------------ Halaman

  var PAGES = {
    dashboard: { title: 'Dashboard', icon: '&#9632;', module: 'dashboard' },
    attendance: { title: 'Absensi', icon: '&#128197;', module: 'attendance' },
    pengajuan: { title: 'Pengajuan', icon: '&#128203;', module: 'pengajuan' },
    devices: { title: 'Perangkat', icon: '&#128421;', module: 'devices' },
    employees: { title: 'Karyawan', icon: '&#128101;', module: 'employees' },
    shifts: { title: 'Shift & Jadwal', icon: '&#9200;', module: 'shifts' },
    holidays: { title: 'Hari Libur', icon: '&#127796;', module: 'holidays', perm: 'holidays:read' },
    reports: { title: 'Laporan', icon: '&#128202;', module: 'reports' },
    users: { title: 'Pengguna', icon: '&#128100;', module: 'users', perm: 'users:manage' },
    settings: { title: 'Pengaturan', icon: '&#9881;', module: 'settings', perm: 'settings:read' },
    employee: { title: 'Portal Saya', icon: '&#128188;', module: 'employee' },
  };

  // Halaman khusus karyawan. Saat akun employee masuk, sidebar hanya menampilkan
  // halaman ini sehingga menu admin tidak pernah tampil walau route diketik manual.
  var EMPLOYEE_NAV = [
    {
      label: 'Karyawan',
      items: [{ route: 'employee', label: 'Portal Saya' }],
    },
  ];

  var NAV_SECTIONS = [
    {
      label: 'Utama',
      items: [
        { route: 'dashboard', label: 'Dashboard' },
        { route: 'attendance', label: 'Absensi' },
        { route: 'pengajuan', label: 'Pengajuan' },
        { route: 'reports', label: 'Laporan' },
      ],
    },
    {
      label: 'Data Master',
      items: [
        { route: 'employees', label: 'Karyawan' },
        { route: 'shifts', label: 'Shift & Jadwal' },
        { route: 'holidays', label: 'Hari Libur', perm: 'holidays:read' },
        { route: 'devices', label: 'Mesin Fingerprint' },
      ],
    },
    {
      label: 'Sistem',
      items: [
        { route: 'users', label: 'Pengguna', perm: 'users:manage' },
        { route: 'settings', label: 'Pengaturan', perm: 'settings:read' },
      ],
    },
  ];

  function isEmployeeAccount() {
    return (App.state.user || {}).role === 'employee';
  }

  function activeNavSections() {
    return isEmployeeAccount() ? EMPLOYEE_NAV : NAV_SECTIONS;
  }

  /** Route awal setelah login / buka aplikasi. */
  function defaultRoute() {
    return isEmployeeAccount() ? 'employee' : 'dashboard';
  }

  // ------------------------------------------------------------------ Login

  function renderLogin() {
    document.body.innerHTML =
      '<div class="login-page">' +
        '<div class="login-card">' +
          '<div class="login-logo">&#128421;</div>' +
          '<h1 class="login-title">Aplikasi Absensi</h1>' +
          '<p class="login-sub">Sistem Absensi Fingerprint</p>' +
          '<form id="loginForm" autocomplete="on">' +
            '<div class="field">' +
              '<label for="loginUsername">Username</label>' +
              '<input type="text" id="loginUsername" name="username" autocomplete="username" required autofocus>' +
            '</div>' +
            '<div class="field">' +
              '<label for="loginPassword">Password</label>' +
              '<input type="password" id="loginPassword" name="password" autocomplete="current-password" required>' +
            '</div>' +
            '<button type="submit" class="btn primary" id="loginBtn">Masuk</button>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '<div class="toast-container" id="toastContainer"></div>';

    var form = document.getElementById('loginForm');
    var button = document.getElementById('loginBtn');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var username = document.getElementById('loginUsername').value.trim();
      var password = document.getElementById('loginPassword').value;

      if (!username || !password) {
        App.toast('Username dan password wajib diisi.', 'error');
        return;
      }

      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Memproses...';

      api.post('/auth/login', { username: username, password: password })
        .then(function (res) {
          api.setSession(res.token, res.user);
          App.state.user = res.user;
          loadPermissions()
            .then(function () {
              window.location.hash = '#/' + defaultRoute();
              boot();
            })
            .catch(function () {
              window.location.hash = '#/' + defaultRoute();
              boot();
            });
        })
        .catch(function (err) {
          App.toast(err.message, 'error');
          button.disabled = false;
          button.textContent = 'Masuk';
          document.getElementById('loginPassword').value = '';
          document.getElementById('loginPassword').focus();
        });
    });
  }

  function loadPermissions() {
    return api.get('/auth/me').then(function (res) {
      App.state.user = res.user;
      App.state.permissions = res.permissions || {};
      api.setUser(res.user);
      api.setPermissions(App.state.permissions);
    });
  }

  function loadMeta() {
    return api.get('/auth/meta').then(function (res) {
      App.state.meta = res.data || { departments: [], positions: [], shifts: [] };
    }).catch(function () {
      App.state.meta = { departments: [], positions: [], shifts: [] };
    });
  }

  // ------------------------------------------------------------------ Layout

  function currentRoute() {
    var hash = window.location.hash.replace(/^#\/?/, '').trim();
    if (!hash) return defaultRoute();
    var parts = hash.split('/');
    if (!PAGES[parts[0]]) return defaultRoute();
    // Akun employee dipaksa ke portalnya, jadi halaman admin tidak bisa dibuka
    // hanya dengan mengetik hash.
    if (isEmployeeAccount() && parts[0] !== 'employee') return 'employee';
    return parts[0];
  }

  function renderShell() {
    var user = App.state.user || { full_name: 'Pengguna', username: '-', role: '-' };

    var navHtml = activeNavSections().map(function (section) {
      var items = section.items.filter(function (item) {
        return !item.perm || App.can(item.perm);
      });
      if (items.length === 0) return '';

      return '<div class="nav-section">' + esc(section.label) + '</div>' +
        items.map(function (item) {
          var page = PAGES[item.route];
          return '<a class="nav-item" href="#/' + item.route + '" data-route="' + item.route + '">' +
            '<span class="icon">' + (page ? page.icon : '') + '</span>' +
            '<span>' + esc(item.label) + '</span>' +
          '</a>';
        }).join('');
    }).join('');

    var roleLabels = {
      admin: 'Administrator',
      hr: 'HR',
      operator: 'Operator',
      viewer: 'Viewer',
      employee: 'Karyawan',
    };

    var sidebarTitle = isEmployeeAccount() ? 'PORTAL KARYAWAN' : 'ABSENSI';
    var sidebarSub = isEmployeeAccount() ? 'Self Service' : 'Fingerprint System';

    document.body.innerHTML =
      '<div class="layout">' +
        '<aside class="sidebar">' +
          '<div class="sidebar-header">' +
            '<div class="sidebar-title">' + sidebarTitle + '</div>' +
            '<div class="sidebar-subtitle">' + sidebarSub + '</div>' +
          '</div>' +
          '<nav class="sidebar-nav">' + navHtml + '</nav>' +
          '<div class="sidebar-footer">' +
            'Versi 1.0 &middot; Node.js<br>' +
            'Zona waktu: Asia/Jakarta' +
          '</div>' +
        '</aside>' +
        '<div class="main">' +
          '<header class="topbar">' +
            '<div>' +
              '<h1 id="pageTitle">Dashboard</h1>' +
              '<div class="topbar-sub" id="pageSub">Ringkasan absensi hari ini</div>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<span class="small muted nowrap" id="clockBox"></span>' +
              '<div class="user-menu" id="userMenu">' +
                '<button type="button" class="user-chip" id="btnUserMenu" aria-haspopup="menu" aria-expanded="false">' +
                  '<div class="avatar">' + esc(App.initials(user.full_name)) + '</div>' +
                  '<div class="user-chip-info">' +
                    '<div class="small" style="font-weight:600">' + esc(user.full_name) + '</div>' +
                    '<div class="small faint">' + esc(roleLabels[user.role] || user.role) + '</div>' +
                  '</div>' +
                  '<span class="user-caret" aria-hidden="true">&#9662;</span>' +
                '</button>' +
                '<div class="user-menu-list" id="userMenuList" role="menu" hidden>' +
                  '<button type="button" class="user-menu-item" role="menuitem" data-act="password">Ganti Password</button>' +
                  '<button type="button" class="user-menu-item danger" role="menuitem" data-act="logout">Keluar</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</header>' +
          '<main class="content" id="pageContent"></main>' +
        '</div>' +
      '</div>' +
      '<div class="toast-container" id="toastContainer"></div>';

    setupUserMenu();

    startClock();
  }

  /** Dropdown profil: ganti password + keluar, digantungkan di tombol profil. */
  function setupUserMenu() {
    var wrap = document.getElementById('userMenu');
    var trigger = document.getElementById('btnUserMenu');
    var list = document.getElementById('userMenuList');
    if (!wrap || !trigger || !list) return;

    function setOpen(open) {
      wrap.classList.toggle('open', open);
      list.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    trigger.addEventListener('click', function (ev) {
      ev.stopPropagation();
      setOpen(list.hidden);
    });

    list.addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-act]');
      if (!item) return;
      setOpen(false);
      if (item.getAttribute('data-act') === 'password') openChangePassword();
      else logout();
    });

    document.addEventListener('click', function (ev) {
      if (!wrap.contains(ev.target)) setOpen(false);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') setOpen(false);
    });
  }

  function logout() {
    App.confirm({
      title: 'Keluar dari aplikasi',
      heading: 'Akhiri sesi?',
      message: 'Anda akan diminta masuk kembali untuk membuka aplikasi.',
      confirmLabel: 'Ya, Keluar',
      onConfirm: function () {
        api.clearSession();
        App.state.user = null;
        App.state.permissions = null;
        stopClock();
        window.location.hash = '';
        renderLogin();
      },
    });
  }

  var clockTimer = null;

  function startClock() {
    stopClock();
    var box = document.getElementById('clockBox');
    if (!box) return;

    function tick() {
      var d = new Date();
      var dateStr = App.DAY_NAMES[d.getDay()] + ', ' + d.getDate() + ' ' + App.MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
      box.textContent = dateStr + ' ' + App.pad(d.getHours()) + ':' + App.pad(d.getMinutes());
    }
    tick();
    clockTimer = setInterval(tick, 30000);
  }

  function stopClock() {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function openChangePassword() {
    App.modal({
      title: 'Ganti Password',
      bodyHtml:
        '<div class="callout">Masukkan password saat ini dan password baru (minimal 8 karakter).</div>' +
        '<div class="field mb">' +
          '<label>Password Saat Ini <span class="req">*</span></label>' +
          '<input type="password" id="cpCurrent" autocomplete="current-password">' +
        '</div>' +
        '<div class="field mb">' +
          '<label>Password Baru <span class="req">*</span></label>' +
          '<input type="password" id="cpNew" autocomplete="new-password">' +
        '</div>' +
        '<div class="field">' +
          '<label>Ulangi Password Baru <span class="req">*</span></label>' +
          '<input type="password" id="cpConfirm" autocomplete="new-password">' +
        '</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Password',
          className: 'primary',
          onClick: function (el) {
            var current = el.querySelector('#cpCurrent').value;
            var next = el.querySelector('#cpNew').value;
            var confirm = el.querySelector('#cpConfirm').value;

            if (!current || !next) {
              App.toast('Semua kolom wajib diisi.', 'error');
              return false;
            }
            if (next.length < 8) {
              App.toast('Password baru minimal 8 karakter.', 'error');
              return false;
            }
            if (next !== confirm) {
              App.toast('Ulangi password tidak sama dengan password baru.', 'error');
              return false;
            }

            api.post('/auth/change-password', { current_password: current, new_password: next })
              .then(function () {
                App.toast('Password berhasil diganti.', 'success');
                el.closeModal();
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

  // ------------------------------------------------------------------ Render

  function renderPage() {
    var route = currentRoute();
    var page = PAGES[route] || PAGES.dashboard;

    if (isEmployeeAccount() && route !== 'employee') {
      window.location.hash = '#/employee';
      return;
    }

    if (page.perm && !App.can(page.perm)) {
      document.getElementById('pageContent').innerHTML =
        '<div class="card"><div class="empty-state">' +
          '<div class="big">&#128683;</div>' +
          '<div>Halaman ini tidak tersedia untuk peran Anda.</div>' +
        '</div></div>';
      return;
    }

    document.getElementById('pageTitle').textContent = page.title;
    document.getElementById('pageSub').textContent = '';

    // Tandai menu aktif
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (el) {
      el.classList.toggle('active', el.getAttribute('data-route') === route);
    });

    var content = document.getElementById('pageContent');
    content.innerHTML = App.loading('Menyiapkan halaman...');

    var module = window.Pages ? window.Pages[page.module] : null;
    if (typeof module !== 'function') {
      content.innerHTML =
        '<div class="card"><div class="empty-state">' +
          '<div class="big">&#128193;</div>' +
          '<div>Modul halaman <strong>' + esc(page.module) + '</strong> belum dimuat.</div>' +
        '</div></div>';
      return;
    }

    Promise.resolve(module(content, page)).catch(function (err) {
      console.error('[render]', err);
      content.innerHTML =
        '<div class="card"><div class="empty-state">' +
          '<div class="big">&#9888;</div>' +
          '<div><strong>Gagal memuat halaman.</strong></div>' +
          '<div class="small muted mt">' + esc(err.message || 'Error tidak diketahui') + '</div>' +
          '<button class="btn mt" onclick="location.reload()">Muat Ulang</button>' +
        '</div></div>';
    });
  }

  function boot() {
    if (!api.isLoggedIn()) {
      renderLogin();
      return;
    }

    // Validasi token masih valid sebelum menampilkan UI.
    loadPermissions()
      .then(function () {
        renderShell();
        return loadMeta();
      })
      .then(function () {
        if (!window.location.hash) window.location.hash = '#/' + defaultRoute();
        renderPage();
      })
      .catch(function (err) {
        if (err && err.status === 401) {
          api.clearSession();
          App.toast('Sesi habis, silakan masuk kembali.', 'warning');
          renderLogin();
          return;
        }
        renderShell();
        renderPage();
      });
  }

  window.addEventListener('hashchange', function () {
    if (api.isLoggedIn() && document.getElementById('pageContent')) renderPage();
  });

  // ------------------------------------------------------------------ Export

  /** Modul halaman didaftarkan oleh berkas js/pages/*.js ke objek ini. */
  window.Pages = window.Pages || {};

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
