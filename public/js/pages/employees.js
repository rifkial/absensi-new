/* =============================================================================
 * Halaman KARYAWAN (master + jadwal + izin + sidik jari)
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var filters = { search: '', status: 'aktif', department_id: '', device_id: '', page: 1, per_page: 25 };
  var rows = [];
  var meta = {};
  var stats = {};

  window.Pages.employees = function (root) {
    root.innerHTML =
      '<div class="stat-grid" id="empStats"></div>' +

      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="toolbar" style="margin:0;flex:1">' +
            '<div class="field grow">' +
              '<label>Cari</label>' +
              '<input type="text" id="empSearch" placeholder="Nama, kode, PIN, atau email...">' +
            '</div>' +
            '<div class="field">' +
              '<label>Unit Kerja</label>' +
              '<select id="empDept"><option value="">Semua</option></select>' +
            '</div>' +
            '<div class="field">' +
              '<label>Status</label>' +
              '<select id="empStatus">' +
                '<option value="aktif">Aktif</option>' +
                '<option value="nonaktif">Nonaktif</option>' +
                '<option value="resign">Resign</option>' +
                '<option value="">Semua</option>' +
              '</select>' +
            '</div>' +
            '<div class="field">' +
              '<label>Mesin</label>' +
              '<select id="empDevice"><option value="">Semua</option></select>' +
            '</div>' +
            '<div class="field" style="min-width:auto">' +
              '<label>&nbsp;</label>' +
              '<button class="btn" id="empFilter">Terapkan</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            (App.can('employees:write') ? '<button class="btn primary" id="empAdd">+ Tambah Karyawan</button>' : '') +
            (App.can('employees:write') ? '<button class="btn" id="empImport">Impor CSV</button>' : '') +
            '<a class="btn" href="/api/employees/template">Unduh Template CSV</a>' +
          '</div>' +
          '<div class="small muted" id="empCount"></div>' +
        '</div>' +
        '<div class="card-body tight" id="empTable">' + App.loading('Memuat karyawan...') + '</div>' +
        '<div id="empPager"></div>' +
      '</div>';

    fillMeta();
    bind();
    loadStats();
    load();
  };

  function fillMeta() {
    var meta_ = App.state.meta || { departments: [], positions: [], shifts: [], devices: [] };
    var dept = document.getElementById('empDept');
    var dev = document.getElementById('empDevice');

    if (dept) {
      dept.innerHTML = '<option value="">Semua</option>' +
        (meta_.departments || []).map(function (d) {
          return '<option value="' + d.id + '">' + esc(d.name) + '</option>';
        }).join('');
      dept.value = filters.department_id || '';
    }

    if (dev) {
      var devices = meta_.devices || [];
      dev.innerHTML = '<option value="">Semua</option>' +
        (devices.length === 0
          ? '<option value="" disabled>(belum ada mesin)</option>'
          : devices.map(function (d) {
              var label = d.name + (d.location ? ' - ' + d.location : '');
              if (Number(d.is_active) !== 1) label += ' (nonaktif)';
              return '<option value="' + d.id + '">' + esc(label) + '</option>';
            }).join(''));
      dev.value = filters.device_id || '';
    }
  }

  function bind() {
    var search = document.getElementById('empSearch');
    search.value = filters.search;

    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        filters.search = search.value.trim();
        filters.page = 1;
        load();
      }, 400);
    });

    document.getElementById('empStatus').value = filters.status;
    document.getElementById('empStatus').addEventListener('change', function () {
      filters.status = this.value;
      filters.page = 1;
      load();
    });

    document.getElementById('empDept').addEventListener('change', function () {
      filters.department_id = this.value;
      filters.page = 1;
      load();
    });

    document.getElementById('empDevice').addEventListener('change', function () {
      filters.device_id = this.value;
      filters.page = 1;
      load();
    });

    document.getElementById('empFilter').addEventListener('click', function () {
      filters.search = search.value.trim();
      filters.department_id = document.getElementById('empDept').value;
      filters.device_id = document.getElementById('empDevice').value;
      filters.status = document.getElementById('empStatus').value;
      filters.page = 1;
      load();
    });

    var add = document.getElementById('empAdd');
    if (add) add.addEventListener('click', function () { openForm(null); });

    var imp = document.getElementById('empImport');
    if (imp) imp.addEventListener('click', openImport);

    var table = document.getElementById('empTable');
    table.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      var act = btn.getAttribute('data-act');
      var row = rows.find(function (r) { return r.id === id; });
      if (!row) return;

      if (act === 'edit') openForm(row);
      else if (act === 'detail') openDetail(row.id);
      else if (act === 'delete') doDelete(row);
    });
  }

  function loadStats() {
    api.get('/employees/stats')
      .then(function (res) {
        stats = res.data || {};
        document.getElementById('empStats').innerHTML =
          card('Total', stats.total, '') +
          card('Aktif', stats.aktif, 'success') +
          card('Sudah punya PIN', stats.punya_pin, 'info') +
          card('Sidik jari Terdaftar', stats.fp_terdaftar, 'purple') +
          card('Nonaktif / Resign', (Number(stats.nonaktif) || 0) + (Number(stats.resign) || 0), 'warning');
      })
      .catch(function () {
        document.getElementById('empStats').innerHTML = '';
      });
  }

  function card(label, value, kind) {
    return '<div class="stat ' + kind + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + App.formatNumber(value) + '</div>' +
    '</div>';
  }

  function load() {
    var box = document.getElementById('empTable');
    box.innerHTML = App.loading('Memuat karyawan...');

    api.get('/employees', filters)
      .then(function (res) {
        rows = res.data || [];
        meta = res.meta || {};
        paint();
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paint() {
    var box = document.getElementById('empTable');
    var count = document.getElementById('empCount');
    count.textContent = App.formatNumber(meta.total || 0) + ' karyawan';

    var columns = [
      { key: 'employee_code', label: 'Kode', mono: true },
      { key: 'device_user_id', label: 'PIN Mesin', mono: true, render: function (r) {
        return r.device_user_id
          ? '<span class="badge success">' + esc(r.device_user_id) + '</span>'
          : '<span class="badge idle">belum</span>';
      } },
      { key: 'name', label: 'Nama', render: function (r) {
        return '<div style="font-weight:500">' + esc(r.name) + '</div>' +
          (r.email ? '<div class="small faint">' + esc(r.email) + '</div>' : '');
      } },
      { key: 'device_name', label: 'Mesin', render: function (r) {
        if (!r.device_id) {
          return '<span class="faint" title="Kosong = boleh absen di semua mesin">semua mesin</span>';
        }
        return '<span class="badge info">' + esc(r.device_name || '-mesin-') + '</span>';
      } },
      { key: 'department_name', label: 'Unit Kerja', render: function (r) { return esc(r.department_name || '-'); } },
      { key: 'position_name', label: 'Jabatan', render: function (r) { return esc(r.position_name || '-'); } },
      { key: 'fingerprint_status', label: 'Sidik Jari', render: function (r) {
        if (r.fingerprint_status === 'terdaftar') return '<span class="badge success">Terdaftar</span>';
        if (r.fingerprint_status === 'rusak') return '<span class="badge failed">Rusak</span>';
        return '<span class="badge idle">Belum</span>';
      } },
      { key: 'status', label: 'Status', render: function (r) {
        if (r.status === 'aktif') return '<span class="badge success">Aktif</span>';
        if (r.status === 'resign') return '<span class="badge warning">Resign</span>';
        return '<span class="badge idle">Nonaktif</span>';
      } },
      { key: 'annual_leave_quota', label: 'Cuti Tahunan', align: 'right', render: function (r) {
        return quotaCell(r);
      } },
      { key: 'aksi', label: 'Aksi', width: '150px', render: function (r) {
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="detail" data-id="' + r.id + '">Detail</button>' +
          (App.can('employees:write') ? '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' : '') +
          (App.can('employees:delete') ? '<button class="btn sm danger" data-act="delete" data-id="' + r.id + '">Hapus</button>' : '') +
        '</div>';
      } },
    ];

    box.innerHTML = App.table(columns, rows, {
      empty: 'Tidak ada karyawan yang cocok dengan filter.',
      emptyIcon: '&#128101;',
    });

    var pager = document.getElementById('empPager');
    if ((meta.total_pages || 0) > 1) {
      pager.innerHTML = '<div class="pagination">' +
        '<span>Halaman ' + meta.page + ' dari ' + meta.total_pages + '</span>' +
        '<button class="btn sm" data-pg="prev"' + (meta.page <= 1 ? ' disabled' : '') + '>&laquo; Sebelumnya</button>' +
        '<button class="btn sm" data-pg="next"' + (meta.page >= meta.total_pages ? ' disabled' : '') + '>Berikutnya &raquo;</button>' +
      '</div>';

      pager.querySelectorAll('button[data-pg]').forEach(function (b) {
        b.addEventListener('click', function () {
          filters.page = b.getAttribute('data-pg') === 'next' ? meta.page + 1 : meta.page - 1;
          load();
        });
      });
    } else {
      pager.innerHTML = '';
    }
  }

  // ---------------------------------------------------------------- Form

  function openForm(row) {
    var isEdit = Boolean(row);
    var meta_ = App.state.meta || { departments: [], positions: [], shifts: [] };

    var body =
      '<div class="form-grid">' +
        field('employee_code', 'Kode Karyawan', isEdit ? row.employee_code : '', true,
          'Kode unik internal, mis. 001 atau NIP.') +
        field('device_user_id', 'PIN Mesin', isEdit ? row.device_user_id || '' : '', false,
          'Harus sama dengan User ID / PIN pada mesin fingerprint. Kosongkan bila belum terdaftar.') +
        deviceField(isEdit ? row : null) +
        field('name', 'Nama Lengkap', isEdit ? row.name : '', true) +
        selectField('gender', 'Jenis Kelamin', isEdit ? row.gender || '' : '',
          [['', '-'], ['L', 'Laki-laki'], ['P', 'Perempuan']]) +
        selectField('department_id', 'Unit Kerja', isEdit ? row.department_id || '' : '',
          [['', '- (kosong)'].concat((meta_.departments || []).map(function (d) { return [d.id, d.name]; }))]) +
        selectField('position_id', 'Jabatan', isEdit ? row.position_id || '' : '',
          [['', '- (kosong)'].concat((meta_.positions || []).map(function (p) { return [p.id, p.name]; }))]) +
        selectField('shift_id', 'Shift Default', isEdit ? row.shift_id || '' : '',
          [['', '- (kosong)'].concat((meta_.shifts || []).map(function (s) { return [s.id, s.code + ' - ' + s.name]; }))]) +
        field('phone', 'Telepon / WhatsApp', isEdit ? row.phone || '' : '', false, 'Dipakai untuk notifikasi WhatsApp.') +
        field('email', 'Email', isEdit ? row.email || '' : '', false, 'Dipakai untuk notifikasi email.') +
        field('hire_date', 'Tanggal Masuk', isEdit ? (row.hire_date || '').slice(0, 10) : '', false, 'Format YYYY-MM-DD.') +
        selectField('status', 'Status', isEdit ? row.status : 'aktif',
          [['aktif', 'Aktif'], ['nonaktif', 'Nonaktif'], ['resign', 'Resign']]) +
        quotaField(isEdit ? row : null) +
        field('address', 'Alamat', isEdit ? row.address || '' : '', false, '', 'textarea') +
        field('notes', 'Catatan', isEdit ? row.notes || '' : '', false, '', 'textarea') +
      '</div>';

    App.modal({
      title: isEdit ? 'Ubah Karyawan: ' + row.name : 'Tambah Karyawan',
      size: 'wide',
      bodyHtml: body,
      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Simpan Karyawan',
          className: 'primary',
          onClick: function (el) {
            var payload = collect(el, isEdit);
            if (payload.error) {
              App.toast(payload.error, 'error');
              return false;
            }

            var request = isEdit
              ? api.put('/employees/' + row.id, payload)
              : api.post('/employees', payload);

            request
              .then(function (res) {
                App.toast(isEdit ? 'Karyawan diperbarui.' : 'Karyawan "' + res.data.name + '" ditambahkan.', 'success');
                load();
                loadStats();
                if (!isEdit) reloadMeta();
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

  /**
   * Field jatah cuti tahunan. Kolom "terpakai" sengaja tidak bisa diedit di
   * sini: angka itu hanya berubah saat pengajuan disetujui atau saat admin/HR
   * menekan tombol Reset di halaman detail.
   */
  function quotaField(row) {
    var quota = row ? Number(row.annual_leave_quota || 0) : 0;
    var used = row ? Number(row.annual_leave_used || 0) : 0;
    var remaining = quota - used;

    var readOnly = row
      ? '<div class="field">' +
          '<label>Cuti Tahunan Terpakai</label>' +
          '<input type="text" value="' + used + ' dari ' + quota + ' hari" disabled>' +
          '<span class="help">Sisa ' + remaining + ' hari. Dikurangi otomatis saat pengajuan cuti tahunan disetujui.</span>' +
        '</div>'
      : '';

    return '<div class="field">' +
      '<label>Jatah Cuti Tahunan</label>' +
      '<input type="number" id="f_annual_leave_quota" min="0" max="365" step="1" value="' + quota + '">' +
      '<span class="help">Jumlah hari kerja per tahun, diinput manual. Isi 0 bila karyawan tidak punya jatah cuti tahunan.</span>' +
    '</div>' + readOnly;
  }

  /**
   * Field "Mesin Fingerprint" pada form karyawan.
   *
   * Opsi diambil dari daftar mesin yang sudah terdaftar (menu Perangkat), baik
   * mesin TCP yang disinkronkan maupun mesin PUSH yang mendaftarkan dirinya
   * sendiri. Kosong berarti karyawan boleh absen di semua mesin.
   */
  function deviceField(row) {
    var devices = (App.state.meta || {}).devices || [];

    var options = [['', 'Semua mesin (bebas absen di mana saja)']]
      .concat(devices.map(function (d) {
        var label = d.name + (d.location ? ' - ' + d.location : '');
        if (Number(d.is_active) !== 1) label += ' (nonaktif)';
        return [d.id, label];
      }));

    var current = row ? (row.device_id || '') : '';
    var help = devices.length === 0
      ? 'Belum ada mesin terdaftar. Tambahkan dulu di menu Perangkat - daftar di sini diambil dari data mesin fingerprint yang sudah ada.'
      : 'Mesin absen yang ditunjuk untuk karyawan ini. Kosongkan bila boleh absen di semua mesin. ' +
        'Absen di mesin lain tetap dihitung hadir, tetapi diberi label berbeda di laporan.';

    return selectField('device_id', 'Mesin Fingerprint', current, options, help);
  }

  /** Sel "sisa / jatah" cuti tahunan untuk tabel daftar karyawan. */
  function quotaCell(r) {
    var quota = Number(r.annual_leave_quota || 0);
    if (quota <= 0) return '<span class="faint">-</span>';

    var used = Number(r.annual_leave_used || 0);
    var remaining = quota - used;
    var cls = remaining <= 0 ? 'failed' : remaining <= 2 ? 'warning' : 'success';

    return '<span class="badge ' + cls + '">' + remaining + ' / ' + quota + '</span>';
  }

  /**
   * Panel jatah cuti tahunan di halaman detail: angka sisa, tombol reset, dan
   * riwayat perubahan. Reset mengembalikan jatah terpakai ke 0 tanpa mengubah
   * status pengajuan yang sudah disetujui.
   */
  function quotaPanel(quota, employee) {
    if (!quota) {
      return '<div class="callout">Data jatah cuti tidak dapat dimuat.</div>';
    }

    var html =
      '<div class="grid-2" style="gap:8px;margin-bottom:12px">' +
        statBox('Jatah', quota.quota + ' hari') +
        statBox('Terpakai', quota.used + ' hari') +
        statBox('Sisa', quota.remaining + ' hari') +
      '</div>';

    html += quota.reset_at
      ? '<span class="help">Terakhir dikembalikan penuh pada ' + esc(App.fmtDateTime(quota.reset_at)) + '.</span>'
      : '<span class="help">Belum pernah dikembalikan penuh.</span>';

    if (App.can('employees:write') && quota.quota > 0 && quota.used > 0) {
      html += '<div class="btn-group" style="margin-top:8px">' +
        '<button class="btn sm" id="btnResetQuota">Reset Jatah Cuti</button>' +
      '</div>';
    }

    html += '<div style="margin-top:12px">' + quotaLogTable(quota.logs) + '</div>';

    return '<div id="quotaPanel" data-employee-name="' +
      escAttr(employee ? employee.name : '') + '">' + html + '</div>';
  }

  function quotaLogTable(logs) {
    return App.table([
      { key: 'created_at', label: 'Waktu', render: function (r) { return esc(App.fmtDateTime(r.created_at)); } },
      { key: 'action', label: 'Aksi', render: function (r) {
        var labels = { potong: 'Pemotongan', kembalikan: 'Pengembalian', reset: 'Reset', set_jatah: 'Ubah Jatah' };
        var cls = r.action === 'potong' ? 'failed' : 'success';
        return '<span class="badge ' + cls + '">' + esc(labels[r.action] || r.action) + '</span>';
      } },
      { key: 'days', label: 'Hari', align: 'right', render: function (r) {
        return Number(r.days) > 0 ? '+' + r.days : String(r.days);
      } },
      { key: 'used_after', label: 'Sisa', align: 'right' },
      { key: 'reason', label: 'Keterangan' },
    ], logs || [], { empty: 'Belum ada perubahan jatah.', emptyIcon: '&#128197;' });
  }

  function statBox(label, value) {
    return '<div class="stat">' +
      '<div class="stat-value">' + esc(value) + '</div>' +
      '<div class="stat-label">' + esc(label) + '</div>' +
    '</div>';
  }

  function confirmResetQuota(employeeId, employeeName) {
    App.confirm({
      title: 'Reset Jatah Cuti Tahunan',
      heading: 'Reset jatah ' + employeeName + '?',
      message:
        'Jatah cuti tahunan akan dikembalikan ke jumlah semula. ' +
        'Status pengajuan yang sudah disetujui tidak berubah, hanya hitungan jatahnya.',
      danger: true,
      confirmLabel: 'Ya, Reset',
      onConfirm: function () {
        api.post('/employees/' + employeeId + '/leave-quota/reset', {})
          .then(function (res) {
            App.toast(res.message || 'Jatah cuti berhasil dikembalikan.', 'success');
            refreshQuotaPanel(employeeId);
            load();
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  /**
   * Muat ulang panel jatah cuti di dalam modal detail yang sedang terbuka,
   * tanpa membuka modal baru, lalu pasang ulang listener tombol reset.
   */
  function refreshQuotaPanel(employeeId) {
    var panel = document.getElementById('quotaPanel');
    if (!panel) return;

    api.get('/employees/' + employeeId + '/leave-quota')
      .then(function (res) {
        panel.innerHTML = quotaPanelBody(res.data);
        bindResetButton(panel, employeeId, panel.getAttribute('data-employee-name') || 'karyawan ini');
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  /** Isi panel saja, tanpa pembungkus #quotaPanel, untuk refresh. */
  function quotaPanelBody(quota) {
    var html = quotaPanel(quota, null);
    return html
      .replace(/^<div id="quotaPanel"[^>]*>/, '')
      .replace(/<\/div>$/, '');
  }

  function bindResetButton(root, employeeId, employeeName) {
    var btn = root.querySelector('#btnResetQuota');
    if (!btn) return;
    btn.addEventListener('click', function () {
      confirmResetQuota(employeeId, employeeName);
    });
  }

  function field(name, label, value, required, help, type) {
    return '<div class="field">' +
      '<label>' + esc(label) + (required ? ' <span class="req">*</span>' : '') + '</label>' +
      (type === 'textarea'
        ? '<textarea id="f_' + name + '" rows="2">' + esc(value) + '</textarea>'
        : '<input type="' + (type || 'text') + '" id="f_' + name + '" value="' + escAttr(value) + '">') +
      (help ? '<span class="help">' + esc(help) + '</span>' : '') +
    '</div>';
  }

  function selectField(name, label, value, options, help) {
    return '<div class="field">' +
      '<label>' + esc(label) + '</label>' +
      '<select id="f_' + name + '">' +
        options.map(function (o) {
          var v = o[0];
          var selected = String(v) === String(value) ? ' selected' : '';
          return '<option value="' + escAttr(v) + '"' + selected + '>' + esc(o[1]) + '</option>';
        }).join('') +
      '</select>' +
      (help ? '<span class="help">' + esc(help) + '</span>' : '') +
    '</div>';
  }

  function escAttr(v) {
    return esc(v);
  }

  function collect(el, isEdit) {
    var get = function (id) {
      var node = el.querySelector('#f_' + id);
      return node ? node.value.trim() : '';
    };

    var code = get('employee_code');
    var name = get('name');

    if (!code) return { error: 'Kode karyawan wajib diisi.' };
    if (!name) return { error: 'Nama lengkap wajib diisi.' };

    var pin = get('device_user_id');
    if (pin && pin.length > 50) return { error: 'PIN mesin maksimal 50 karakter.' };
    if (pin && !/^[A-Za-z0-9._-]+$/.test(pin)) {
      return { error: 'PIN mesin hanya boleh huruf, angka, titik, garis, dan garis bawah.' };
    }

    var payload = {
      employee_code: code,
      name: name,
      gender: get('gender') || null,
      department_id: numOrNull(get('department_id')),
      position_id: numOrNull(get('position_id')),
      shift_id: numOrNull(get('shift_id')),
      device_id: numOrNull(get('device_id')),
      phone: get('phone') || null,
      email: get('email') || null,
      address: get('address') || null,
      hire_date: get('hire_date') || null,
      status: get('status') || 'aktif',
      notes: get('notes') || null,
      fingerprint_status: isEdit ? undefined : 'belum',
      annual_leave_quota: quotaValue(get('annual_leave_quota')),
    };

    payload.device_user_id = pin || null;
    if (payload.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
      return { error: 'Format email tidak valid.' };
    }
    if (payload.annual_leave_quota === null) {
      return { error: 'Jatah cuti tahunan harus bilangan bulat antara 0 dan 365.' };
    }

    Object.keys(payload).forEach(function (k) {
      if (payload[k] === undefined) delete payload[k];
    });

    return payload;
  }

  function numOrNull(v) {
    return v === '' || v === null ? null : Number(v);
  }

  /** Jatah cuti tahunan: kosong berarti 0, dan harus bilangan bulat 0-365. */
  function quotaValue(v) {
    if (v === '' || v === null) return 0;
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) return null;
    if (n < 0 || n > 365) return null;
    return n;
  }

  /**
   * Muat ulang meta setelah ada karyawan/mesin baru.
   * Memakai api.get('/auth/meta') lalu setter resmi dari app.js supaya
   * field baru (devices) ikut terisi dan tidak ada logika dobel di sini.
   */
  function reloadMeta() {
    if (typeof App.reloadMeta === 'function') {
      App.reloadMeta().then(fillMeta).catch(function () {});
      return;
    }
    api.get('/auth/meta').then(function (res) {
      App.state.meta = res.data;
      fillMeta();
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- Detail

  function openDetail(id) {
    var box = document.getElementById('empDetailBody') || rootOf();
    App.modal({
      title: 'Detail Karyawan',
      size: 'wide',
      bodyHtml: '<div id="empDetailBody">' + App.loading('Memuat...') + '</div>',
      actions: [{ label: 'Tutup' }],
      onMount: function (el) {
        var target = el.querySelector('#empDetailBody');
        Promise.all([
          api.get('/employees/' + id),
          api.get('/employees/' + id + '/fingerprints'),
          api.get('/employees/' + id + '/schedules', { from: App.today(), to: App.addDays(App.today(), 30) }),
          api.get('/employees/' + id + '/leaves'),
          api.get('/employees/' + id + '/leave-quota').catch(function () { return { data: null }; }),
        ]).then(function (res) {
          var e = res[0].data;
          var fps = res[1].data || [];
          var scheds = res[2].data || [];
          var leaves = res[3].data || [];
          var quota = res[4].data || null;

          target.innerHTML =
            '<div class="grid-2">' +
              '<div>' +
                '<h4 style="margin:0 0 8px">Informasi Dasar</h4>' +
                App.table([
                  { key: 'employee_code', label: 'Kode' },
                  { key: 'device_user_id', label: 'PIN Mesin' },
                  { key: 'device_name', label: 'Mesin Ditunjuk', render: function (r) {
                    if (!r.device_id) {
                      return '<span class="faint">Semua mesin (bebas absen di mana saja)</span>';
                    }
                    return '<span class="badge info">' + esc(r.device_name || '-') + '</span>' +
                      (r.device_location ? ' <span class="small faint">' + esc(r.device_location) + '</span>' : '');
                  } },
                  { key: 'name', label: 'Nama' },
                  { key: 'department_name', label: 'Unit Kerja' },
                  { key: 'position_name', label: 'Jabatan' },
                  { key: 'phone', label: 'Telepon' },
                  { key: 'email', label: 'Email' },
                  { key: 'hire_date', label: 'Tanggal Masuk', render: function (r) { return App.fmtDate(r.hire_date); } },
                  { key: 'status', label: 'Status' },
                ], [e], { empty: 'Data tidak ditemukan.' }) +

                '<h4 style="margin:16px 0 8px">Jatah Cuti Tahunan</h4>' +
                quotaPanel(quota, e) +
              '</div>' +
              '<div>' +
                '<h4 style="margin:0 0 8px">Sidik Jari di Mesin</h4>' +
                App.table([
                  { key: 'finger_index', label: 'Jari' },
                  { key: 'size_bytes', label: 'Ukuran', align: 'right', render: function (r) { return App.fmtBytes(r.size_bytes); } },
                  { key: 'valid', label: 'Valid', render: function (r) { return Number(r.valid) ? 'Ya' : 'Tidak'; } },
                  { key: 'updated_at', label: 'Diperbarui', render: function (r) { return App.fmtDate(r.updated_at); } },
                ], fps, { empty: 'Belum ada template sidik jari yang masuk lewat mode PUSH.', emptyIcon: '&#128403;' }) +

                '<h4 style="margin:16px 0 8px">Jadwal 30 Hari Ke Depan</h4>' +
                App.table([
                  { key: 'work_date', label: 'Tanggal', render: function (r) { return App.fmtDate(r.work_date); } },
                  { key: 'day_type', label: 'Jenis', render: function (r) {
                    return r.day_type === 'libur'
                      ? '<span class="badge hari_libur">Libur</span>'
                      : '<span class="badge success">Kerja</span>';
                  } },
                ], scheds, { empty: 'Belum ada jadwal khusus. Semua hari mengikuti jam kerja global.' }) +

                '<h4 style="margin:16px 0 8px">Riwayat Izin / Sakit / Cuti</h4>' +
                App.table([
                  { key: 'leave_type', label: 'Jenis', render: function (r) { return esc(App.LEAVE_LABELS[r.leave_type] || r.leave_type); } },
                  { key: 'start_date', label: 'Mulai', render: function (r) { return App.fmtDate(r.start_date); } },
                  { key: 'end_date', label: 'Selesai', render: function (r) { return App.fmtDate(r.end_date); } },
                  { key: 'status', label: 'Status', render: function (r) {
                    var s = r.status || 'pending';
                    var cls = s === 'approved' ? 'success' : (s === 'rejected' ? 'failed' : 'warning');
                    return '<span class="badge ' + cls + '">' + esc(App.LEAVE_STATUS_LABELS[s] || s) + '</span>';
                  } },
                ], leaves, { empty: 'Belum ada pengajuan.' }) +
              '</div>' +
            '</div>';

          if (App.can('attendance:write')) {
            var addSchedule = document.createElement('div');
            addSchedule.className = 'btn-group mt';
            addSchedule.innerHTML = '<button class="btn sm primary" id="btnAddSchedule">+ Atur Jadwal</button>' +
              '<button class="btn sm" id="btnAddLeave">+ Pengajuan Izin</button>' +
              '<button class="btn sm" id="btnDailyRecap">Rekap Harian</button>';
            target.appendChild(addSchedule);

            addSchedule.querySelector('#btnAddSchedule').addEventListener('click', function () { openScheduleForm(e); });
            addSchedule.querySelector('#btnAddLeave').addEventListener('click', function () { openLeaveForm(e); });
            addSchedule.querySelector('#btnDailyRecap').addEventListener('click', function () { openRecap(e); });
          }

          var panel = target.querySelector('#quotaPanel');
          if (panel) bindResetButton(panel, e.id, e.name);
        }).catch(function (err) {
          target.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
        });
      },
    });

    void box;
  }

  function rootOf() {
    return null;
  }

  function openScheduleForm(emp) {
    var meta_ = App.state.meta || { shifts: [] };
    var from = App.today();

    App.modal({
      title: 'Atur Jadwal: ' + emp.name,
      bodyHtml:
        '<div class="callout">Jadwal khusus untuk tanggal tertentu. Tanggal yang dibiarkan kosong akan memakai shift default karyawan.</div>' +
        '<div class="form-grid">' +
          '<div class="field">' +
            '<label>Dari Tanggal <span class="req">*</span></label>' +
            '<input type="date" id="schFrom" value="' + esc(from) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label>Sampai Tanggal <span class="req">*</span></label>' +
            '<input type="date" id="schTo" value="' + esc(App.addDays(from, 6)) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label>Jenis Hari</label>' +
            '<select id="schType">' +
              '<option value="kerja">Hari Kerja</option>' +
              '<option value="libur">Hari Libur</option>' +
              '<option value="cuti">Cuti</option>' +
            '</select>' +
          '</div>' +
          '<div class="field">' +
            '<label>Shift</label>' +
            '<select id="schShift"><option value="">- (tanpa shift) -</option>' +
              (meta_.shifts || []).map(function (s) {
                return '<option value="' + s.id + '">' + esc(s.code + ' - ' + s.name) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="field mt">' +
          '<label>Catatan (opsional)</label>' +
          '<input type="text" id="schNote" placeholder="mis. Jadwal nazis, shift pengganti">' +
        '</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Jadwal',
          className: 'primary',
          onClick: function (el) {
            var start = el.querySelector('#schFrom').value;
            var end = el.querySelector('#schTo').value;
            if (!start || !end) { App.toast('Tanggal wajib diisi.', 'error'); return false; }
            if (end < start) { App.toast('Tanggal akhir tidak boleh lebih awal.', 'error'); return false; }

            var entries = [];
            var cursor = start;
            var guard = 0;
            while (cursor <= end && guard < 400) {
              entries.push({
                work_date: cursor,
                day_type: el.querySelector('#schType').value,
                shift_id: el.querySelector('#schShift').value || null,
                note: el.querySelector('#schNote').value.trim() || null,
              });
              cursor = App.addDays(cursor, 1);
              guard += 1;
            }

            api.post('/employees/' + emp.id + '/schedules', { entries: entries })
              .then(function (res) {
                App.toast(res.data.saved + ' tanggal jadwal disimpan. Rekap perlu dihitung ulang.', 'success');
                el.closeModal();
                api.post('/attendance/generate', {
                  from: start, to: end, employee_id: emp.id,
                }).catch(function () {});
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

  function openLeaveForm(emp) {
    var LEAVE_CATALOG = [
      {
        key: 'cuti',
        label: 'Cuti',
        subtypes: [
          { key: 'cuti_tahunan', label: 'Cuti Tahunan' },
          { key: 'cuti_melahirkan', label: 'Cuti Melahirkan' },
          { key: 'cuti_menikah', label: 'Cuti Menikah' },
          { key: 'cuti_haji', label: 'Cuti Haji / Umrah' },
          { key: 'cuti_kematian_keluarga', label: 'Cuti Kematian Keluarga' },
          { key: 'cuti_alasan_penting', label: 'Cuti Alasan Penting' },
          { key: 'cuti_tanpa_bayar', label: 'Cuti Tanpa Bayar' },
          { key: 'cuti_lainnya', label: 'Cuti Lainnya' },
        ],
      },
      {
        key: 'izin',
        label: 'Izin',
        subtypes: [
          { key: 'izin_tidak_masuk', label: 'Izin Tidak Masuk' },
          { key: 'izin_terlambat', label: 'Izin Terlambat' },
          { key: 'izin_pulang_cepat', label: 'Izin Pulang Cepat' },
          { key: 'izin_kebutuhan_pribadi', label: 'Izin Keperluan Pribadi' },
          { key: 'izin_keluarga', label: 'Izin Mengurus Keluarga' },
          { key: 'izin_administrasi', label: 'Izin Mengurus Administrasi / Dokumen' },
          // Tidak ada Izin Sakit / Cuti Sakit: kondisi sakit diinput
          // sebagai izin biasa, sehingga tercatat sebagai izin.
          { key: 'izin_meninggal', label: 'Izin Kematian Keluarga' },
          { key: 'izin_lainnya', label: 'Izin Lainnya' },
        ],
      },
      {
        key: 'dinas',
        label: 'Dinas',
        subtypes: [
          { key: 'dinas_dalam_kota', label: 'Dinas Dalam Kota', single_day: true },
          { key: 'dinas_luar_kota', label: 'Dinas Luar Kota', single_day: false },
        ],
      },
    ];

    var categoryOptions = LEAVE_CATALOG.map(function (c) {
      return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>';
    }).join('');

    App.modal({
      title: 'Pengajuan: ' + emp.name,
      bodyHtml:
        '<div class="callout">Setelah disetujui, rekap otomatis akan berstatus izin / cuti / dinas sehingga tidak dihitung alpa. ' +
          'Kondisi sakit diisi sebagai izin biasa.</div>' +
        '<div class="field"><label>Kategori <span class="req">*</span></label>' +
          '<select id="lvCategory">' + categoryOptions + '</select></div>' +
        '<div class="field" id="lvSubtypeWrap"><label>Jenis <span class="req">*</span></label>' +
          '<select id="lvSubtype"></select></div>' +
        '<div class="field" id="lvPlaceWrap" style="display:none"><label>Tujuan / Lokasi <span class="req">*</span></label>' +
          '<input type="text" id="lvPlace" maxlength="150" placeholder="Contoh: Kantor cabang Surabaya"></div>' +
        '<div class="field checkbox full mt" id="lvVehicleWrap" style="display:none">' +
          '<input type="checkbox" id="lvUseVehicle">' +
          '<label for="lvUseVehicle">Menggunakan kendaraan operasional</label>' +
          '<span class="help">Setelah pengajuan disetujui, pengantar mobil keluar bisa dicetak dari menu Pengajuan.</span>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Tanggal Mulai <span class="req">*</span></label>' +
            '<input type="date" id="lvStart" value="' + esc(App.today()) + '"></div>' +
          '<div class="field" id="lvEndWrap"><label>Tanggal Selesai <span class="req">*</span></label>' +
            '<input type="date" id="lvEnd" value="' + esc(App.today()) + '"></div>' +
        '</div>' +
        '<div class="field mt">' +
          '<label>Keterangan <span class="req">*</span></label>' +
          '<textarea id="lvReason" rows="2" placeholder="Jelaskan keterangan pengajuan"></textarea>' +
        '</div>' +
        '<div class="field checkbox mt">' +
          '<input type="checkbox" id="lvApprove" checked>' +
          '<label for="lvApprove">Langsung disetujui (tidak perlu review)</label>' +
        '</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Pengajuan',
          className: 'primary',
          onClick: function (el) {
            var category = el.querySelector('#lvCategory').value;
            var subtype = el.querySelector('#lvSubtype').value;
            var start = el.querySelector('#lvStart').value;
            var end = el.querySelector('#lvEnd').value;
            var reason = el.querySelector('#lvReason').value.trim();
            var place = el.querySelector('#lvPlace').value.trim();
            var vehicleBox = el.querySelector('#lvUseVehicle');

            if (!start || !end) { App.toast('Tanggal wajib diisi.', 'error'); return false; }
            if (end < start) { App.toast('Tanggal selesai tidak boleh lebih awal.', 'error'); return false; }
            if (!reason) { App.toast('Keterangan wajib diisi.', 'error'); return false; }

            var autoApprove = el.querySelector('#lvApprove').checked;

            var payload = {
              category: category,
              subtype: subtype,
              start_date: start,
              end_date: end,
              reason: reason,
            };
            if (place) payload.place = place;
            if (vehicleBox && vehicleBox.checked) payload.use_vehicle = true;

            api.post('/employees/' + emp.id + '/leaves', payload)
              .then(function (res) {
                App.toast('Pengajuan disimpan.', 'success');
                el.closeModal();
                if (autoApprove) {
                  api.put('/employees/leaves/' + res.data.id + '/review', { status: 'approved' })
                    .then(function () {
                      App.toast('Pengajuan disetujui. Rekap sedang dihitung.', 'success');
                      return api.post('/attendance/generate', { from: start, to: end, employee_id: emp.id });
                    })
                    .catch(function () {});
                }
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

    var categorySelect = document.getElementById('lvCategory');
    var subtypeSelect = document.getElementById('lvSubtype');
    var subtypeWrap = document.getElementById('lvSubtypeWrap');
    var placeWrap = document.getElementById('lvPlaceWrap');
    var endWrap = document.getElementById('lvEndWrap');
    var vehicleWrap = document.getElementById('lvVehicleWrap');
    var vehicleBox = document.getElementById('lvUseVehicle');

    /** Opsi kendaraan hanya untuk Dinas Luar Kota. */
    function syncVehicle(sub) {
      var show = Boolean(sub && sub.key === 'dinas_luar_kota');
      if (vehicleWrap) vehicleWrap.style.display = show ? '' : 'none';
      if (!show && vehicleBox && vehicleBox.checked) vehicleBox.checked = false;
    }

    function updateForm() {
      var catKey = categorySelect.value;
      var cat = null;
      for (var i = 0; i < LEAVE_CATALOG.length; i++) {
        if (LEAVE_CATALOG[i].key === catKey) { cat = LEAVE_CATALOG[i]; break; }
      }
      if (!cat) {
        subtypeWrap.style.display = 'none';
        placeWrap.style.display = 'none';
        endWrap.style.display = '';
        syncVehicle(null);
        return;
      }

      subtypeWrap.style.display = '';
      subtypeSelect.innerHTML = cat.subtypes.map(function (s) {
        return '<option value="' + esc(s.key) + '">' + esc(s.label) + '</option>';
      }).join('');

      var sub = cat.subtypes[0];
      var isDinas = catKey === 'dinas';
      var isSingleDay = sub && sub.single_day;

      placeWrap.style.display = isDinas ? '' : 'none';
      endWrap.style.display = isSingleDay ? 'none' : '';
      syncVehicle(sub);
    }

    categorySelect.addEventListener('change', updateForm);
    subtypeSelect.addEventListener('change', function () {
      var catKey = categorySelect.value;
      var cat = null;
      for (var i = 0; i < LEAVE_CATALOG.length; i++) {
        if (LEAVE_CATALOG[i].key === catKey) { cat = LEAVE_CATALOG[i]; break; }
      }
      if (!cat) return;
      var sub = null;
      for (var j = 0; j < cat.subtypes.length; j++) {
        if (cat.subtypes[j].key === subtypeSelect.value) { sub = cat.subtypes[j]; break; }
      }
      if (!sub) return;
      var isDinas = catKey === 'dinas';
      var isSingleDay = sub.single_day;
      placeWrap.style.display = isDinas ? '' : 'none';
      endWrap.style.display = isSingleDay ? 'none' : '';
      syncVehicle(sub);
    });

    updateForm();
  }

  function openRecap(emp) {
    App.modal({
      title: 'Rekap Harian: ' + emp.name,
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field">' +
            '<label>Tanggal <span class="req">*</span></label>' +
            '<input type="date" id="rcDate" value="' + esc(App.today()) + '">' +
          '</div>' +
        '</div>' +
        '<div class="divider"></div>' +
        '<div class="field" style="margin-bottom:12px">' +
          '<label>Ubah Status Manual (opsional)</label>' +
          '<select id="rcStatus">' +
            '<option value="">- Jangan diubah -</option>' +
            '<option value="hadir">Hadir</option>' +
            '<option value="telat">Telat</option>' +
            '<option value="izin">Izin</option>' +
            '<option value="sakit">Sakit</option>' +
            '<option value="cuti">Cuti</option>' +
            '<option value="alpa">Alpa</option>' +
            '<option value="belum">Belum Absen</option>' +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label>Catatan Koreksi</label>' +
          '<input type="text" id="rcNote" placeholder="mis. Scanner bermasalah, absen manual disetujui">' +
        '</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Terapkan',
          className: 'primary',
          onClick: function (el) {
            var date = el.querySelector('#rcDate').value;
            var status = el.querySelector('#rcStatus').value;
            var note = el.querySelector('#rcNote').value.trim();

            if (!date) { App.toast('Tanggal wajib diisi.', 'error'); return false; }

            var request = status
              ? api.put('/attendance/override/' + emp.id + '/' + date, { status: status, note: note })
              : api.post('/attendance/generate', { from: date, to: date, employee_id: emp.id });

            request
              .then(function () {
                App.toast(status ? 'Koreksi manual tersimpan.' : 'Rekap dihitung ulang.', 'success');
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

  // ---------------------------------------------------------------- Import

  function openImport() {
    App.modal({
      title: 'Impor Karyawan dari CSV',
      size: 'wide',
      bodyHtml:
        '<div class="callout">' +
          '<strong>Format kolom yang dikenali</strong>' +
          'employee_code, device_user_id, device_id, name, gender, department_id, position_id, shift_id, phone, email, hire_date, status' +
          '<br>device_id boleh dikosongkan atau diisi dengan "nama_mesin" / "nama mesin". ' +
          'Bila diisi, karyawan ditunjuk ke mesin tersebut; bila kosong, karyawan boleh absen di semua mesin.' +
        '</div>' +
        '<div class="callout warning">' +
          '<strong>Aturan</strong>' +
          'Kode karyawan wajib unik. Baris dengan kode yang sudah ada akan diperbarui, bukan diduplikasi. ' +
          'Sebaiknya unduh template dulu agar nama kolom pasti sesuai.' +
        '</div>' +
        '<div class="field mb">' +
          '<label>Pilih File <span class="req">*</span></label>' +
          '<input type="file" id="impFile" accept=".csv,.txt,.tsv">' +
          '<span class="help">Format .csv atau .txt, maksimal 15 MB. Pemisah otomatis dideteksi (koma, titik koma, atau tab).</span>' +
        '</div>' +
        '<div id="impResult" class="mt"></div>',
      actions: [
        { label: 'Tutup' },
        {
          label: 'Impor Sekarang',
          className: 'primary',
          onClick: function (el) {
            var input = el.querySelector('#impFile');
            if (!input.files || input.files.length === 0) {
              App.toast('Pilih file CSV terlebih dahulu.', 'error');
              return false;
            }

            var form = new FormData();
            form.append('file', input.files[0]);

            var resultBox = el.querySelector('#impResult');
            resultBox.innerHTML = App.loading('Mengunggah dan memproses...');

            api.upload('/employees/import', form)
              .then(function (res) {
                var d = res.data || {};
                resultBox.innerHTML =
                  '<div class="callout success"><strong>Impor selesai</strong>' +
                  'Total baris: ' + App.formatNumber(d.total) +
                  ' | Dibuat: ' + App.formatNumber(d.inserted) +
                  ' | Diperbarui: ' + App.formatNumber(d.updated) +
                  (d.failed ? ' | Gagal: ' + App.formatNumber(d.failed) : '') +
                  '</div>' +
                  (d.errors && d.errors.length
                    ? App.table([
                        { key: 'row', label: 'Baris' },
                        { key: 'message', label: 'Masalah' },
                      ], d.errors.slice(0, 50), { empty: 'Tidak ada error.' })
                    : '');

                load();
                loadStats();
                reloadMeta();
              })
              .catch(function (err) {
                resultBox.innerHTML = '<div class="callout danger"><strong>Impor gagal</strong>' + esc(err.message) + '</div>';
                return false;
              });
            return false;
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- Delete

  function doDelete(row) {
    App.confirm({
      title: 'Hapus karyawan',
      heading: 'Hapus ' + row.name + '?',
      message: 'Karyawan akan dinonaktifkan (status resign) agar riwayat absensi tetap tersimpan. Data absensi historis tidak dihapus.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/employees/' + row.id)
          .then(function (res) {
            App.toast(res.message || 'Karyawan dihapus.', 'success');
            load();
            loadStats();
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }
})();
