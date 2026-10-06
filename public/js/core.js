/* =============================================================================
 * APLIKASI ABSENSI FINGERPRINT - Inti Frontend
 *
 * Berisi:
 *   - Konfigurasi & helper
 *   - API client (fetch + JWT)
 *   - Penyimpanan state
 *   - Komponen UI reusable (modal, toast, tabel)
 *   - Router hash-based
 * ========================================================================== */

(function () {
  'use strict';

  // ------------------------------------------------------------------ Config

  var API_BASE = '/api';
  // Tanpa timeout, fetch yang menggantung (proxy/server tidak merespons) membuat
  // spinner di halaman berjalan tanpa henti dan tanpa pesan error.
  var REQUEST_TIMEOUT_MS = 30000;
  var DOWNLOAD_TIMEOUT_MS = 120000;
  var TOKEN_KEY = 'absensi_token';
  var USER_KEY = 'absensi_user';
  var PERMS_KEY = 'absensi_perms';

  // ------------------------------------------------------------------ Labels

  var STATUS_LABELS = {
    hadir: 'Hadir',
    telat: 'Telat',
    izin: 'Izin',
    sakit: 'Sakit',
    cuti: 'Cuti',
    alpa: 'Alpa',
belum: 'Belum Absen',
    hari_libur: 'Hari Libur',
    dinas_luar: 'Dinas Luar Kota',
  };

  var LOG_STATE_LABELS = {
    0: 'Check-In',
    1: 'Check-Out',
    2: 'Break-Out',
    3: 'Break-In',
    4: 'Otomatisasi',
    5: 'Access Denied',
  };

  var VERIFY_LABELS = {
    0: 'Password',
    1: 'Kartu',
    2: 'Sidik Jari',
    3: 'Wajah',
    4: 'Telepon',
    5: 'Kartu + Sidik Jari',
    15: 'Kartu + Wajah',
    20: 'Kartu + Telepon',
  };

  var LEAVE_LABELS = {
    izin: 'Izin',
    sakit: 'Sakit',
    cuti: 'Cuti',
    izin_meninggal: 'Izin Meninggal',
    dinas_luar: 'Dinas Luar Kota',
  };

  var LEAVE_STATUS_LABELS = {
    pending: 'Menunggu',
    approved: 'Disetujui',
    rejected: 'Ditolak',
  };

  var MONTH_NAMES = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ];

  var DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

  // ------------------------------------------------------------------ Storage

  var storage = {
    get: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {
        /* mode privat / storage penuh: abaikan */
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* abaikan */
      }
    },
  };

  function readJson(key, fallback) {
    var raw = storage.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      storage.remove(key);
      return fallback;
    }
  }

  // ------------------------------------------------------------------ Escapes

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  // ------------------------------------------------------------------ Format

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function todayStr(date) {
    var d = date instanceof Date ? date : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function nowDateTimeInput() {
    var d = new Date();
    return todayStr() + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function formatDate(value) {
    if (!value) return '-';
    var s = String(value);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s;
    return m[3] + ' ' + MONTH_NAMES[Number(m[2]) - 1] + ' ' + m[1];
  }

  function formatDateFull(value) {
    if (!value) return '-';
    var s = String(value).slice(0, 10);
    var parts = s.split('-');
    if (parts.length !== 3) return s;
    var dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(dt.getTime())) return s;
    return DAY_NAMES[dt.getDay()] + ', ' + Number(parts[2]) + ' ' + MONTH_NAMES[Number(parts[1]) - 1] + ' ' + parts[0];
  }

  function formatTime(value) {
    if (!value) return '-';
    var s = String(value);
    var m = /(\d{2}:\d{2})(:\d{2})?/.exec(s);
    return m ? m[1] : s;
  }

  function formatDateTime(value) {
    if (!value) return '-';
    var s = String(value);
    if (s.length >= 16 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      return formatDate(s) + ', ' + formatTime(s);
    }
    return s;
  }

  function formatNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) return '0';
    return n.toLocaleString('id-ID');
  }

  function formatMinutes(total) {
    var m = Number(total) || 0;
    if (m <= 0) return '-';
    var h = Math.floor(m / 60);
    var r = m % 60;
    if (h === 0) return r + ' menit';
    if (r === 0) return h + ' jam';
    return h + ' jam ' + r + ' mnt';
  }

  function formatBytes(value) {
    var n = Number(value) || 0;
    if (n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    if (i >= units.length) i = units.length - 1;
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatRelative(value) {
    if (!value) return 'belum pernah';
    var then = new Date(String(value).replace(' ', 'T'));
    if (isNaN(then.getTime())) return String(value);
    var diff = Math.floor((Date.now() - then.getTime()) / 1000);
    if (diff < 0) return formatDateTime(value);
    if (diff < 60) return diff + ' detik lalu';
    if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
    if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
    if (diff < 604800) return Math.floor(diff / 86400) + ' hari lalu';
    return formatDateTime(value);
  }

  function monthLabel(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!m) return ym || '-';
    return MONTH_NAMES[Number(m[2]) - 1] + ' ' + m[1];
  }

  function addDaysStr(dateStr, days) {
    var parts = String(dateStr || todayStr()).slice(0, 10).split('-');
    var dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    dt.setDate(dt.getDate() + days);
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }

  function startOfMonthStr() {
    return todayStr().slice(0, 7) + '-01';
  }

  function initials(name) {
    var s = String(name || '?').trim();
    var parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ------------------------------------------------------------------ Query

  function toQuery(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === null || value === undefined || value === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return parts.length > 0 ? '?' + parts.join('&') : '';
  }

  // ------------------------------------------------------------------ API

  function ApiError(message, status, details) {
    this.name = 'ApiError';
    this.message = message || 'Terjadi kesalahan.';
    this.status = status || 0;
    this.details = details || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var api = {
    token: storage.get(TOKEN_KEY),

    get tokenShort() {
      return this.token ? this.token.slice(-8) : '-';
    },

    isLoggedIn: function () {
      return Boolean(this.token);
    },

    setSession: function (token, user) {
      this.token = token;
      storage.set(TOKEN_KEY, token);
      storage.set(USER_KEY, JSON.stringify(user || null));
    },

    setUser: function (user) {
      storage.set(USER_KEY, JSON.stringify(user || null));
    },

    setPermissions: function (perms) {
      storage.set(PERMS_KEY, JSON.stringify(perms || {}));
    },

    clearSession: function () {
      this.token = null;
      storage.remove(TOKEN_KEY);
      storage.remove(USER_KEY);
      storage.remove(PERMS_KEY);
    },

    request: function (method, path, options) {
      var opts = options || {};
      var url = API_BASE + path + (opts.query ? toQuery(opts.query) : '');

      var headers = { Accept: 'application/json' };
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      if (opts.body !== undefined && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
      }

      var init = {
        method: method,
        headers: headers,
        credentials: 'same-origin',
      };

      if (opts.body !== undefined) {
        init.body = opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body);
      }
      if (opts.signal) init.signal = opts.signal;
      else if (typeof AbortController === 'function') {
        init.signal = AbortSignal.timeout(opts.raw ? DOWNLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      }

      return fetch(url, init).then(function (res) {
        var contentType = res.headers.get('content-type') || '';

        if (opts.raw) {
          if (!res.ok) {
            return res.text().then(function (text) {
              throw new ApiError('Gagal mengunduh file (' + res.status + ').', res.status);
            });
          }
          return res.blob().then(function (blob) {
            return { blob: blob, filename: filenameFromDisposition(res) };
          });
        }

        if (contentType.indexOf('application/json') === -1) {
          if (!res.ok) throw new ApiError('Server menolak permintaan (' + res.status + ').', res.status);
          return res.text();
        }

        return res.json().then(function (body) {
          if (!res.ok || body.ok === false) {
            var err = (body && body.error) || {};
            throw new ApiError(err.message || 'Permintaan gagal (' + res.status + ').', res.status, err.details);
          }
          return body;
        });
      }).catch(function (err) {
        if (err instanceof ApiError) throw err;

        if (err && err.name === 'AbortError') {
          if (opts.raw) throw new ApiError('Unduhan dibatalkan / terlalu lama.', 0);
          throw new ApiError('Permintaan terlalu lama (timeout). Periksa koneksi ke server.', 0);
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          throw new ApiError('Tidak ada koneksi ke server.', 0);
        }
        throw new ApiError('Tidak bisa menghubungi server. Pastikan server aplikasi berjalan.', 0);
      });
    },

    get: function (path, query) {
      return this.request('GET', path, { query: query });
    },
    post: function (path, body) {
      return this.request('POST', path, { body: body === undefined ? {} : body });
    },
    put: function (path, body) {
      return this.request('PUT', path, { body: body === undefined ? {} : body });
    },
    del: function (path, body) {
      return this.request('DELETE', path, { body: body === undefined ? {} : body });
    },
    upload: function (path, formData) {
      return this.request('POST', path, { body: formData });
    },
    download: function (path, query) {
      return this.request('GET', path, { query: query, raw: true });
    },
  };

  function filenameFromDisposition(res) {
    var header = res.headers.get('content-disposition') || '';
    var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
    return m ? decodeURIComponent(m[1]) : 'unduh';
  }

  // ------------------------------------------------------------------ State

  var state = {
    user: readJson(USER_KEY, null),
    permissions: readJson(PERMS_KEY, {}),
    meta: { departments: [], positions: [], shifts: [] },
    employees: [],
    devices: [],
    lastRoute: '',
  };

  function can(action) {
    if (!action) return true;
    return Boolean(state.permissions[action]);
  }

  function requirePermission(action) {
    if (can(action)) return true;
    toast('Anda tidak punya hak akses untuk aksi ini.', 'error');
    return false;
  }

  // ------------------------------------------------------------------ Toast

  function toast(message, type, duration) {
    var container = document.getElementById('toastContainer');
    if (!container) return;

    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    container.appendChild(el);

    var ms = duration || (type === 'error' ? 6000 : 3500);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }, ms);
  }

  // ------------------------------------------------------------------ Modal

  var openModals = [];

  /**
   * Buka modal.
   * @param {Object} opts
   *   title     - judul
   *   bodyHtml  - isi (string HTML)
   *   size      - '' | 'wide'
   *   actions   - [{ label, className, value, primary }]
   *   onAction  - function(value, modalEl) -> true untuk tutup otomatis
   *   onMount   - function(modalEl) setelah masuk DOM
   */
  function modal(opts) {
    var o = opts || {};
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    var actionsHtml = '';
    if (o.actions && o.actions.length > 0) {
      actionsHtml = '<div class="modal-footer">' +
        o.actions.map(function (a, i) {
          return '<button type="button" class="btn ' + (a.className || '') + '" data-action-index="' + i + '">' +
            escapeHtml(a.label) + '</button>';
        }).join('') + '</div>';
    }

    backdrop.innerHTML =
      '<div class="modal ' + (o.size === 'wide' ? 'wide' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-header">' +
          '<h3 class="modal-title">' + escapeHtml(o.title || '') + '</h3>' +
          '<button type="button" class="close-x" data-close aria-label="Tutup">&times;</button>' +
        '</div>' +
        '<div class="modal-body">' + (o.bodyHtml || '') + '</div>' +
        actionsHtml +
      '</div>';

    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';

    var record = { el: backdrop, opts: o };
    openModals.push(record);

    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      var idx = openModals.indexOf(record);
      if (idx >= 0) openModals.splice(idx, 1);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (openModals.length === 0) document.body.style.overflow = '';
      if (typeof o.onClose === 'function') o.onClose();
    }

    // Form yang menyimpan lewat request asynchronous harus `return false`
    // supaya modal tidak menutup sebelum server membalas. Setelah sukses,
    // handler memanggil el.closeModal() untuk menutupnya secara eksplisit.
    backdrop.closeModal = close;

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) {
        if (o.dismissible !== false) close();
        return;
      }

      if (ev.target.closest('[data-close]')) {
        close();
        return;
      }

      var btn = ev.target.closest('[data-action-index]');
      if (btn) {
        var action = o.actions[Number(btn.getAttribute('data-action-index'))];
        var result;
        if (typeof action.onClick === 'function') {
          result = action.onClick(backdrop);
        } else if (typeof o.onAction === 'function') {
          result = o.onAction(action.value, backdrop);
        }
        if (result !== false) close();
        return;
      }

      if (typeof o.onClick === 'function') o.onClick(ev, backdrop);
    });

    // Fokus ke input pertama agar bisa langsung ketik.
    setTimeout(function () {
      var first = backdrop.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
      if (first) first.focus();
    }, 60);

    if (typeof o.onMount === 'function') o.onMount(backdrop);

    return { el: backdrop, close: close };
  }

  function confirmDialog(opts) {
    var o = opts || {};
    return modal({
      title: o.title || 'Konfirmasi',
      bodyHtml:
        '<div class="callout ' + (o.danger ? 'danger' : 'warning') + '">' +
          '<strong>' + escapeHtml(o.heading || 'Yakin ingin melanjutkan?') + '</strong>' +
          escapeHtml(o.message || '') +
        '</div>' +
        (o.extraHtml || ''),
      actions: [
        { label: o.cancelLabel || 'Batal', className: '' },
        { label: o.confirmLabel || 'Ya, Lanjutkan', className: o.danger ? 'danger' : 'primary', value: 'confirm' },
      ],
      onAction: function (value) {
        if (value === 'confirm' && typeof o.onConfirm === 'function') {
          o.onConfirm();
        }
        return true;
      },
    });
  }

  // ------------------------------------------------------------------ Table

  /**
   * Render tabel HTML.
   * columns: [{ key, label, align, width, render(row) }]
   * options: { empty, rowAttr(row) }
   */
  function table(columns, rows, options) {
    var o = options || {};
    var list = rows || [];

    if (list.length === 0) {
      return '<div class="empty-state">' +
        '<div class="big">' + (o.emptyIcon || '&#9634;') + '</div>' +
        '<div>' + escapeHtml(o.empty || 'Belum ada data.') + '</div>' +
      '</div>';
    }

    var head = columns.map(function (c) {
      return '<th' + (c.align === 'right' ? ' class="num"' : '') +
        (c.width ? ' style="width:' + c.width + '"' : '') + '>' + escapeHtml(c.label) + '</th>';
    }).join('');

    var body = list.map(function (row, index) {
      var attrs = typeof o.rowAttr === 'function' ? o.rowAttr(row, index) || '' : '';
      var cells = columns.map(function (c) {
        var content = typeof c.render === 'function' ? c.render(row, index) : escapeHtml(row[c.key]);
        var cls = [];
        if (c.align === 'right') cls.push('num');
        if (c.mono) cls.push('mono');
        return '<td' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' + (content === undefined || content === null ? '-' : content) + '</td>';
      }).join('');
      return '<tr' + attrs + '>' + cells + '</tr>';
    }).join('');

    return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function statusBadge(status) {
    var key = String(status || 'belum').toLowerCase();
    var label = STATUS_LABELS[key] || status || '-';
    return '<span class="badge ' + escapeAttr(key) + '">' + escapeHtml(label) + '</span>';
  }

  function loadingRow(text) {
    return '<div class="loading-row"><span class="spinner"></span> ' + escapeHtml(text || 'Memuat data...') + '</div>';
  }

  // ------------------------------------------------------------------ Chart

  /**
   * Grafik batang bertumpuk (CSS based, tanpa dependensi eksternal).
   * data: [{ label, values: {hadir: n, telat: n, ...} }]
   */
  function stackedBarChart(data, series) {
    var list = data || [];
    if (list.length === 0) {
      return '<div class="empty-state">Belum ada data untuk ditampilkan.</div>';
    }

    var keys = series || ['hadir', 'telat', 'izin', 'sakit', 'alpa', 'belum'];
    var totals = list.map(function (item) {
      return keys.reduce(function (sum, k) { return sum + (Number(item.values[k]) || 0); }, 0);
    });
    var max = Math.max.apply(null, totals.concat([1]));

    var bars = list.map(function (item, i) {
      var total = totals[i];
      var heightPercent = total > 0 ? Math.max(3, Math.round((total / max) * 100)) : 0;
      var segs = keys.map(function (k) {
        var v = Number(item.values[k]) || 0;
        if (v <= 0) return '';
        return '<div class="bar-seg ' + escapeAttr(k) + '" style="height:' +
          Math.max(2, Math.round((v / total) * 100)) + '%" title="' +
          escapeAttr((STATUS_LABELS[k] || k) + ': ' + v) + '"></div>';
      }).join('');

      return '<div class="bar-group" title="' +
        escapeAttr(item.label + ' - total ' + total) + '">' +
        '<div class="bar-stack" style="height:' + heightPercent + '%">' + segs + '</div>' +
        '<div class="bar-label">' + escapeHtml(item.label) + '</div>' +
      '</div>';
    }).join('');

    var legend = keys.filter(function (k) {
      return list.some(function (item) { return (Number(item.values[k]) || 0) > 0; });
    }).map(function (k) {
      return '<span><i class="' + k + '" style="background:' + legendColor(k) + '"></i>' +
        escapeHtml(STATUS_LABELS[k] || k) + '</span>';
    }).join('');

    return '<div class="bar-chart">' + bars + '</div>' + (legend ? '<div class="legend">' + legend + '</div>' : '');
  }

  var LEGEND_COLORS = {
    hadir: '#22a06b',
    telat: '#e0a020',
    dinas_luar: '#65a30d',
    izin: '#3b9ddb',
    sakit: '#8b5cf6',
    cuti: '#94a3b8',
    alpa: '#dc4444',
    belum: '#cbd5e1',
  };

  function legendColor(key) {
    return LEGEND_COLORS[key] || '#94a3b8';
  }

  // ---------------------------------------------------- Dokumen cetak (surat)

  /**
   * Cetak pengantar mobil keluar untuk pengajuan dinas luar kota.
   *
   * @param {Object} row  baris pengajuan dari API (leave_requests)
   * @param {Object} info { company, address, phone, vehicle_no, signatory }
   *
   * Dokumen dirender di dalam modal lalu dicetak dengan window.print(); CSS
   * @media print menyembunyikan seluruh kerangka aplikasi dan hanya menyisakan
   * isi .print-doc.
   */
  function printVehicleNote(row, info) {
    var cfg = info || {};
    var meta = state.meta || {};
    var company = cfg.company || meta.company_name || 'Nama Perusahaan';
    var vehicleNo = cfg.vehicle_no || meta.operational_vehicle || '';
    var signatory = cfg.signatory || meta.vehicle_signatory || '';
    var signRole = cfg.sign_role || (signatory ? '' : 'Mengetahui,');
    var employeeName = row.employee_name || cfg.employee_name || '-';
    var employeeCode = row.employee_code || '';

    var periode =
      row.start_date === row.end_date
        ? formatDate(row.start_date)
        : formatDate(row.start_date) + ' s/d ' + formatDate(row.end_date);

    var html =
      '<div class="print-doc">' +
        '<div class="print-doc-head">' +
          '<div class="org">' + escapeHtml(company.toUpperCase()) + '</div>' +
          (cfg.address
            ? '<div class="small">' + escapeHtml(cfg.address) + '</div>'
            : '') +
          (cfg.phone ? '<div class="small">Telp. ' + escapeHtml(cfg.phone) + '</div>' : '') +
          '<div class="title">SURAT PENGANTAR MOBIL KELUAR</div>' +
        '</div>' +
        '<div class="print-doc-meta">' +
          '<p>Nomor: ' + escapeHtml(cfg.number || '-') + '</p>' +
          '<p>Lampiran: ' + (row.id ? '1 (satu) berkas' : '-') + '</p>' +
        '</div>' +
        '<p>Yang bertanda tangan di bawah ini:</p>' +
        '<table class="print-doc-table">' +
          '<tr><th>Nama</th><td>' + escapeHtml(employeeName) +
            (employeeCode ? ' (' + escapeHtml(employeeCode) + ')' : '') + '</td></tr>' +
          '<tr><th>Jabatan</th><td>' + escapeHtml(row.position_name || '-') + '</td></tr>' +
          '<tr><th>Unit Kerja</th><td>' + escapeHtml(row.department_name || '-') + '</td></tr>' +
          '<tr><th>Nomor Kendaraan</th><td>' + escapeHtml(vehicleNo || '-') + '</td></tr>' +
          '<tr><th>Tujuan</th><td>' + escapeHtml(row.place || '-') + '</td></tr>' +
          '<tr><th>Keperluan</th><td>' + escapeHtml(row.reason || '-') + '</td></tr>' +
          '<tr><th>Tanggal keberangkatan</th><td>' + escapeHtml(periode) + '</td></tr>' +
        '</table>' +
        '<p class="print-doc-note">Pengantar ini wajib dikembalikan ke ' +
          'keamanan bersama saat kendaraan kembali ke kantor.</p>' +
        '<div class="print-doc-sign">' +
          '<div>' +
            '<div>' + escapeHtml(cfg.sign_place || company) + ',</div>' +
            '<div>' + escapeHtml(formatDateFull(todayStr())) + '</div>' +
            '<div class="space"></div>' +
            '<div>' + escapeHtml(signRole) + '</div>' +
            '<div class="name">' + escapeHtml(signatory || '..............................') + '</div>' +
            '<div class="role">Tanda tangan &amp; stempel</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    modal({
      title: 'Pengantar Mobil Keluar',
      size: 'wide',
      bodyHtml: html,
      actions: [
        { label: 'Tutup' },
        {
          label: 'Cetak',
          className: 'primary',
          onClick: function () {
            window.print();
            // false supaya modal tetap terbuka bila mau dicetak lagi.
            return false;
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------------ Expose

  window.App = {
    // konfigurasi
    API_BASE: API_BASE,
    // label
    STATUS_LABELS: STATUS_LABELS,
    LOG_STATE_LABELS: LOG_STATE_LABELS,
    VERIFY_LABELS: VERIFY_LABELS,
    LEAVE_LABELS: LEAVE_LABELS,
    LEAVE_STATUS_LABELS: LEAVE_STATUS_LABELS,
    MONTH_NAMES: MONTH_NAMES,
    DAY_NAMES: DAY_NAMES,
    // format
    esc: escapeHtml,
    pad: pad,
    today: todayStr,
    nowInput: nowDateTimeInput,
    fmtDate: formatDate,
    fmtDateFull: formatDateFull,
    fmtTime: formatTime,
    fmtDateTime: formatDateTime,
    fmtNumber: formatNumber,
    formatNumber: formatNumber,
    fmtMinutes: formatMinutes,
    fmtBytes: formatBytes,
    fmtRelative: formatRelative,
    monthLabel: monthLabel,
    addDays: addDaysStr,
    startOfMonth: startOfMonthStr,
    initials: initials,
    // api
    api: api,
    // state
    state: state,
    can: can,
    perm: requirePermission,
    // ui
    toast: toast,
    modal: modal,
    confirm: confirmDialog,
    table: table,
    badge: statusBadge,
    loading: loadingRow,
    chart: stackedBarChart,
    legendColor: legendColor,
    printVehicleNote: printVehicleNote,
  };
})();
