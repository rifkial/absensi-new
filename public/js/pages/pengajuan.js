/* =============================================================================
 * HALAMAN ADMIN - Approval Pengajuan Karyawan (Cuti/Izin/Dinas + Reimburse)
 *
 * Dua mode tampilan:
 *   pending  -> pengajuan yang menunggu persetujuan (bisa disetujui/ditolak)
 *   history  -> riwayat seluruh pengajuan beserta statusnya, sehingga
 *               pengajuan yang sudah diterima/ditolak tetap bisa dibaca
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  var TABS = [
    { key: 'leave', label: 'Cuti / Izin / Dinas' },
    { key: 'reimburse', label: 'Reimburse' },
  ];

  var MODES = [
    { key: 'pending', label: 'Menunggu Persetujuan' },
    { key: 'history', label: 'Riwayat' },
  ];

  var FILTER_STATUS = [
    { key: 'all', label: 'Semua Status' },
    { key: 'pending', label: 'Menunggu' },
    { key: 'approved', label: 'Disetujui' },
    { key: 'rejected', label: 'Ditolak' },
  ];

  var currentTab = 'leave';
  var currentMode = 'pending';
  var historyStatus = 'all';

  var leaveRows = [];
  var reimburseRows = [];
  var leaveHistory = [];
  var reimburseHistory = [];
  var counts = { leave: null, reimburse: null };

  window.Pages = window.Pages || {};

  window.Pages.pengajuan = function (root) {
    root.innerHTML =
      '<div class="card"><div class="card-header">' +
        '<h2 class="card-title">Pengajuan Karyawan</h2>' +
        '<div class="btn-group">' +
          TABS.map(function (t) {
            return '<button class="btn sm" data-tab="' + esc(t.key) + '">' + esc(t.label) + '</button>';
          }).join('') +
          (App.can('attendance:write')
            ? '<button class="btn sm primary" data-new="1">+ Input Pengajuan</button>'
            : '') +
        '</div>' +
      '</div>' +
      '<div class="card-body" id="pjBody">' + App.loading('Memuat pengajuan...') + '</div>' +
    '</div>';

    root.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentTab = btn.getAttribute('data-tab');
        root.querySelectorAll('[data-tab]').forEach(function (b) {
          b.classList.toggle('primary', b.getAttribute('data-tab') === currentTab);
        });
        renderBody();
      });
    });

    var newBtn = root.querySelector('[data-new]');
    if (newBtn) newBtn.addEventListener('click', openCreateForm);

    root.querySelector('[data-tab="leave"]').classList.add('primary');

    loadData();
  };

  // ------------------------------------------------- Input pengajuan (admin/HR)

  function openCreateForm() {
    if (!App.can('attendance:write')) {
      App.toast('Anda tidak punya hak untuk/input pengajuan.', 'error');
      return;
    }

    var meta_ = App.state.meta || {};
    var categories = meta_.leave_categories || [];
    if (categories.length === 0) {
      App.toast('Katalog pengajuan belum dimuat. Muat ulang halaman.', 'error');
      return;
    }

    Promise.all([
      api.get('/employees/options/list'),
      meta_.departments ? Promise.resolve(meta_.departments) : api.get('/auth/meta').then(function (r) {
        App.state.meta = r.data;
        return (r.data && r.data.departments) || [];
      }),
    ])
      .then(function (results) {
        var employees = results[0].data || [];
        var departments = results[1] || [];
        showCreateModal(employees, departments, categories);
      })
      .catch(function (err) {
        App.toast(err.message || 'Gagal memuat data karyawan.', 'error');
      });
  }

  function showCreateModal(employees, departments, categories) {
    var byDept = {};
    employees.forEach(function (e) {
      var key = String(e.department_id || 0);
      if (!byDept[key]) byDept[key] = [];
      byDept[key].push(e);
    });
    var deptOptions = [{ id: '', name: 'Semua Unit Kerja' }].concat(departments);

    var categoryOptions = categories.map(function (c) {
      return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>';
    }).join('');

    var bodyHtml =
      '<div class="form-grid">' +
        field('Unit Kerja', '<select id="ncDept">' + deptOptions.map(function (d) {
          return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>';
        }).join('') + '</select>') +
        field('Karyawan <span class="req">*</span>', '<select id="ncEmp"></select>') +
        field('Kategori <span class="req">*</span>', '<select id="ncCat">' + categoryOptions + '</select>') +
        field('Jenis Pengajuan <span class="req">*</span>', '<select id="ncSub"></select>') +
        field('Tanggal Mulai <span class="req">*</span>', '<input type="date" id="ncStart" value="' + esc(App.today()) + '">') +
        field('Tanggal Selesai', '<input type="date" id="ncEnd" value="' + esc(App.today()) + '">') +
        field('Tujuan / Lokasi', '<input type="text" id="ncPlace" placeholder="Wajib untuk dinas">') +
        field('Keterangan', '<input type="text" id="ncReason" placeholder="Alasan pengajuan (opsional)">') +
      '</div>' +
      '<div class="field checkbox full mt">' +
        '<input type="checkbox" id="ncApprove" checked>' +
        '<label for="ncApprove">Langsung disetujui (tidak menunggu persetujuan)</label>' +
      '</div>' +
      '<div class="callout mt" id="ncInfo">Pilih karyawan, kategori, dan jenis pengajuan.</div>';

    App.modal({
      title: 'Input Pengajuan (Admin/HR)',
      size: 'wide',
      bodyHtml: bodyHtml,
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Pengajuan',
          className: 'primary',
          onClick: function (el) {
            submitCreate(el);
            return false;
          },
        },
      ],
      onMount: function (backdrop) {
        var dept = backdrop.querySelector('#ncDept');
        var emp = backdrop.querySelector('#ncEmp');
        var cat = backdrop.querySelector('#ncCat');
        var sub = backdrop.querySelector('#ncSub');
        var start = backdrop.querySelector('#ncStart');
        var end = backdrop.querySelector('#ncEnd');
        var place = backdrop.querySelector('#ncPlace');
        var info = backdrop.querySelector('#ncInfo');

        function fillEmployees() {
          var list = byDept[dept.value] || employees;
          emp.innerHTML = list.length === 0
            ? '<option value="">- tidak ada karyawan -</option>'
            : list.map(function (e) {
                return '<option value="' + esc(e.id) + '">' + esc(e.employee_code + ' - ' + e.name) + '</option>';
              }).join('');
        }

        function fillSubtypes() {
          var found = null;
          categories.forEach(function (c) { if (c.key === cat.value) found = c; });
          var list = (found && found.subtypes) || [];
          sub.innerHTML = list.map(function (s) {
            return '<option value="' + esc(s.key) + '" data-single="' + (s.single_day ? '1' : '') +
              '" data-place="' + (s.needs_place ? '1' : '') + '">' + esc(s.label) + '</option>';
          }).join('');
          syncSubtype();
        }

        function syncSubtype() {
          var opt = sub.options[sub.selectedIndex];
          if (!opt) return;
          var single = opt.getAttribute('data-single') === '1';
          var needPlace = opt.getAttribute('data-place') === '1';
          end.disabled = single;
          if (single) end.value = start.value;
          place.placeholder = needPlace ? 'Wajib diisi untuk dinas' : 'Tidak dipakai untuk jenis ini';
          info.textContent = needPlace
            ? 'Jenis ini wajib mengisi lokasi/tujuan.'
            : 'Jenis ini tidak memerlukan lokasi/tujuan.';
        }

        dept.addEventListener('change', fillEmployees);
        cat.addEventListener('change', fillSubtypes);
        sub.addEventListener('change', syncSubtype);
        start.addEventListener('change', function () {
          if (end.disabled) end.value = start.value;
        });

        fillEmployees();
        fillSubtypes();
      },
    });

    function submitCreate(modalEl) {
      var get = function (id) {
        var node = modalEl.querySelector('#' + id);
        return node ? node.value : '';
      };
      var approveNode = modalEl.querySelector('#ncApprove');

      var payload = {
        category: get('ncCat'),
        subtype: get('ncSub'),
        start_date: get('ncStart'),
        end_date: get('ncEnd') || get('ncStart'),
        place: get('ncPlace'),
        reason: get('ncReason'),
        status: approveNode && approveNode.checked ? 'approved' : 'pending',
      };
      var employeeId = get('ncEmp');

      if (!employeeId) { App.toast('Karyawan wajib dipilih.', 'error'); return; }
      if (!payload.subtype) { App.toast('Jenis pengajuan wajib dipilih.', 'error'); return; }
      if (!payload.start_date) { App.toast('Tanggal mulai wajib diisi.', 'error'); return; }

      api.post('/employees/' + employeeId + '/leaves', payload)
        .then(function () {
          App.toast(
            payload.status === 'approved' ? 'Pengajuan dicatat dan langsung disetujui.' : 'Pengajuan dicatat, menunggu persetujuan.',
            'success'
          );
          modalEl.closeModal();
          loadData();
        })
        .catch(function (err) {
          App.toast(err.message || 'Gagal menyimpan pengajuan.', 'error');
        });
    }
  }

  function field(label, control) {
    return '<div class="field"><label>' + label + '</label>' + control + '</div>';
  }

  function loadData() {
    Promise.all([
      api.get('/employees/leaves/pending'),
      api.get('/employees/reimburses/pending'),
      api.get('/employees/leaves/history?status=all&limit=300'),
      api.get('/employees/reimburses/history?status=all&limit=300'),
    ])
      .then(function (results) {
        leaveRows = results[0].data || [];
        reimburseRows = results[1].data || [];
        leaveHistory = results[2].data || [];
        reimburseHistory = results[3].data || [];
        counts.leave = (results[2].meta && results[2].meta.counts) || null;
        counts.reimburse = (results[3].meta && results[3].meta.counts) || null;
        renderBody();
      })
      .catch(function (err) {
        var body = document.getElementById('pjBody');
        if (body) {
          body.innerHTML =
            '<div class="empty-state"><div class="big">&#9888;</div>' +
            '<div>' + esc(err.message || 'Gagal memuat pengajuan.') + '</div></div>';
        }
      });
  }

  function renderBody() {
    var body = document.getElementById('pjBody');
    if (!body) return;

    var list = currentTab === 'leave' ? leaveRows : reimburseRows;
    var tabCounts = counts[currentTab];

    var bar =
      '<div class="row" style="align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
        '<div class="btn-group">' +
          MODES.map(function (m) {
            var badge = '';
            if (m.key === 'pending' && list.length > 0) badge = ' (' + list.length + ')';
            return '<button class="btn sm' + (currentMode === m.key ? ' primary' : '') +
              '" data-mode="' + esc(m.key) + '">' + esc(m.label) + badge + '</button>';
          }).join('') +
        '</div>' +
        (tabCounts
          ? '<div class="row" style="gap:6px">' +
              '<span class="badge warning">Menunggu: ' + App.formatNumber(tabCounts.pending) + '</span>' +
              '<span class="badge success">Disetujui: ' + App.formatNumber(tabCounts.approved) + '</span>' +
              '<span class="badge failed">Ditolak: ' + App.formatNumber(tabCounts.rejected) + '</span>' +
            '</div>'
          : '') +
        (currentMode === 'history'
          ? '<select id="pjStatusFilter">' +
              FILTER_STATUS.map(function (f) {
                return '<option value="' + f.key + '"' + (historyStatus === f.key ? ' selected' : '') +
                  '>' + esc(f.label) + '</option>';
              }).join('') +
            '</select>'
          : '') +
      '</div>';

    var content = document.createElement('div');
    body.innerHTML = bar;
    body.appendChild(content);

    body.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentMode = btn.getAttribute('data-mode');
        renderBody();
      });
    });

    var filter = document.getElementById('pjStatusFilter');
    if (filter) {
      filter.addEventListener('change', function () {
        historyStatus = this.value;
        renderBody();
      });
    }

    var box = document.createElement('div');
    box.id = 'pjTable';
    content.appendChild(box);

    if (currentMode === 'pending') {
      if (currentTab === 'leave') renderLeaveTab(box);
      else renderReimburseTab(box);
    } else {
      if (currentTab === 'leave') renderLeaveHistory(box);
      else renderReimburseHistory(box);
    }
  }

  function statusBadge(status) {
    var map = {
      pending: { cls: 'warning', label: 'Menunggu' },
      approved: { cls: 'success', label: 'Disetujui' },
      rejected: { cls: 'failed', label: 'Ditolak' },
    };
    var item = map[String(status || '')] || { cls: 'belum', label: status || '-' };
    return '<span class="badge ' + item.cls + '">' + esc(item.label) + '</span>';
  }

  function filterHistory(rows) {
    if (historyStatus === 'all') return rows;
    return rows.filter(function (r) { return String(r.status) === historyStatus; });
  }

  // --------------------------------------------------------- Tab Leave

  function renderLeaveTab(body) {
    if (leaveRows.length === 0) {
      body.innerHTML =
        '<div class="empty-state"><div class="big">&#128196;</div>' +
        '<div>Tidak ada pengajuan cuti/izin/dinas yang menunggu persetujuan.</div></div>';
      return;
    }

    var columns = [
      {
        key: 'employee_name',
        label: 'Karyawan',
        render: function (r) {
          return '<strong>' + esc(r.employee_name) + '</strong><br><span class="small faint">' +
            esc(r.employee_code) + '</span>';
        },
      },
      {
        key: 'category',
        label: 'Kategori',
        render: function (r) {
          var cat = r.category || '-';
          var label = cat === 'cuti' ? 'Cuti' : cat === 'izin' ? 'Izin' : cat === 'dinas' ? 'Dinas' : cat;
          return '<span class="badge izin">' + esc(label) + '</span>';
        },
      },
      {
        key: 'subtype_label',
        label: 'Jenis',
        render: function (r) {
          return esc(r.subtype_label || r.leave_type || '-');
        },
      },
      {
        key: 'date_range',
        label: 'Tanggal',
        render: function (r) {
          var s = r.start_date || '';
          var e = r.end_date || '';
          if (s && e && s !== e) return esc(s) + ' s/d ' + esc(e);
          return esc(s || '-');
        },
      },
      {
        key: 'place',
        label: 'Tujuan',
        render: function (r) {
          return r.place ? esc(r.place) : '<span class="faint">-</span>';
        },
      },
      {
        key: 'reason',
        label: 'Keterangan',
        render: function (r) {
          return r.reason ? esc(r.reason) : '<span class="faint">-</span>';
        },
      },
      {
        key: 'quota_days',
        label: 'Jatah',
        align: 'right',
        render: function (r) {
          return quotaCell(r);
        },
      },
      {
        key: 'aksi',
        label: 'Aksi',
        align: 'right',
        render: function (r) {
          return (
            '<button class="btn sm" data-detail="' + esc(r.id) + '">Detail</button> ' +
            '<button class="btn sm success" data-approve="' + esc(r.id) + '">Setujui</button> ' +
            '<button class="btn sm danger" data-reject="' + esc(r.id) + '">Tolak</button>'
          );
        },
      },
    ];

    body.innerHTML = App.table(columns, leaveRows, {
      empty: 'Tidak ada pengajuan.',
    });

    body.querySelectorAll('[data-detail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-detail');
        var row = findLeaveRow(id);
        if (row) showLeaveDetail(row);
      });
    });

    body.querySelectorAll('[data-approve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-approve');
        reviewLeave(id, 'approved');
      });
    });

    body.querySelectorAll('[data-reject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-reject');
        reviewLeave(id, 'rejected');
      });
    });
  }

  /** Riwayat pengajuan cuti/izin/dinas: status, pemeriksa, dan alasannya. */
  function renderLeaveHistory(body) {
    var rows = filterHistory(leaveHistory);

    var columns = [
      {
        key: 'employee_name',
        label: 'Karyawan',
        render: function (r) {
          return '<strong>' + esc(r.employee_name) + '</strong><br><span class="small faint">' +
            esc(r.employee_code) + '</span>';
        },
      },
      { key: 'category', label: 'Kategori', render: function (r) {
        var cat = r.category || '-';
        var label = cat === 'cuti' ? 'Cuti' : cat === 'izin' ? 'Izin' : cat === 'dinas' ? 'Dinas' : cat;
        return '<span class="badge izin">' + esc(label) + '</span>';
      } },
      { key: 'subtype_label', label: 'Jenis', render: function (r) {
        return esc(r.subtype_label || r.leave_type || '-');
      } },
      { key: 'date_range', label: 'Tanggal', render: function (r) {
        return esc(r.date_range || r.start_date || '-');
      } },
      { key: 'place', label: 'Tujuan', render: function (r) {
        return r.place ? esc(r.place) : '<span class="faint">-</span>';
      } },
      { key: 'reason', label: 'Keterangan', render: function (r) {
        return r.reason ? esc(r.reason) : '<span class="faint">-</span>';
      } },
      { key: 'status', label: 'Status', render: function (r) { return statusBadge(r.status); } },
      { key: 'reviewer', label: 'Pemeriksa', render: function (r) {
        return r.reviewer ? esc(r.reviewer) : '<span class="faint">-</span>';
      } },
      { key: 'reviewed_at', label: 'Diproses', render: function (r) {
        return r.reviewed_at ? esc(App.fmtDateTime(r.reviewed_at)) : '<span class="faint">-</span>';
      } },
      { key: 'review_note', label: 'Alasan', render: function (r) {
        return r.review_note ? esc(r.review_note) : '<span class="faint">-</span>';
      } },
      { key: 'aksi', label: '', align: 'right', render: function (r) {
        return '<button class="btn sm" data-hdetail="' + esc(r.id) + '">Detail</button>';
      } },
    ];

    body.innerHTML = App.table(columns, rows, {
      empty: 'Belum ada riwayat pengajuan.',
    });

    body.querySelectorAll('[data-hdetail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = findLeaveRow(btn.getAttribute('data-hdetail'));
        if (row) showLeaveDetail(row, true);
      });
    });
  }

  function findLeaveRow(id) {
    var pools = [leaveRows, leaveHistory];
    for (var p = 0; p < pools.length; p++) {
      for (var i = 0; i < pools[p].length; i++) {
        if (String(pools[p][i].id) === String(id)) return pools[p][i];
      }
    }
    return null;
  }

  function showLeaveDetail(row, historyOnly) {
    var catLabel = row.category === 'cuti' ? 'Cuti' :
      row.category === 'izin' ? 'Izin' :
      row.category === 'dinas' ? 'Dinas' : (row.category || '-');

    var pending = row.status === 'pending';

    var actions = [{ label: 'Tutup' }];
    if (pending && !historyOnly) {
      actions.push({
        label: 'Tolak',
        className: 'danger',
        onClick: function (el) {
          reviewLeave(row.id, 'rejected');
          el.closeModal();
          return false;
        },
      });
      actions.push({
        label: 'Setujui',
        className: 'primary',
        onClick: function (el) {
          reviewLeave(row.id, 'approved');
          el.closeModal();
          return false;
        },
      });
    }

    App.modal({
      title: 'Detail Pengajuan: ' + row.employee_name,
      bodyHtml:
        '<div class="grid-2">' +
          kv('Kode', row.employee_code) +
          kv('Kategori', catLabel) +
          kv('Jenis', row.subtype_label || row.leave_type || '-') +
          kv('Tanggal', row.date_range || row.start_date) +
          kv('Tujuan', row.place || '-') +
          kv('Status', row.status_label || row.status) +
          kv('Diajukan', row.created_at) +
          kv('Pemeriksa', row.reviewer || '-') +
        '</div>' +
        '<div class="field mt"><label>Keterangan</label>' +
          '<div class="callout">' + esc(row.reason || '-') + '</div></div>' +
        (row.review_note
          ? '<div class="field mt"><label>Alasan keputusan</label>' +
            '<div class="callout">' + esc(row.review_note) + '</div></div>'
          : ''),
      actions: actions,
    });
  }

  /**
   * Kolom jatah cuti tahunan di daftar pengajuan. Hanya cuti tahunan yang punya
   * kuota; jenis lain ditampilkan sebagai "-".
   */
  function quotaCell(r) {
    if (!r.uses_quota) return '<span class="faint">-</span>';

    var days = Number(r.quota_days || 0);
    var quota = r.leave_quota;

    if (!quota) {
      return '<span class="small">' + days + ' hari kerja</span>';
    }
    if (quota.quota <= 0) {
      return '<span class="badge idle">tanpa jatah</span>';
    }

    var cls = r.quota_short ? 'failed' : 'success';
    return '<span class="badge ' + cls + '" title="Sisa jatah ' + quota.remaining + ' dari ' + quota.quota + ' hari">' +
      days + ' hari / sisa ' + quota.remaining + '</span>';
  }

  function reviewLeave(id, status, force) {
    var note = null;
    if (status === 'rejected') {
      note = prompt('Alasan penolakan (opsional):') || null;
    }

    api
      .put('/employees/leaves/' + id + '/review', {
        status: status,
        review_note: note,
        force: force === true,
      })
      .then(function () {
        App.toast(
          status === 'approved' ? 'Pengajuan disetujui.' : 'Pengajuan ditolak.',
          'success'
        );
        loadData();
      })
      .catch(function (err) {
        // Server menolak karena jatah cuti tahunan kurang: tawarkan persetujuan
        // paksa supaya admin/HR tetap bisa memutuskan.
        if (status === 'approved' && looksLikeQuotaError(err)) {
          App.confirm({
            title: 'Jatah cuti tidak cukup',
            heading: 'Tetap setujui?',
            message: err.message,
            danger: true,
            confirmLabel: 'Ya, Setujui',
            onConfirm: function () {
              reviewLeave(id, 'approved', true);
            },
          });
          return;
        }
        App.toast(err.message, 'error');
      });
  }

  function looksLikeQuotaError(err) {
    return /jatah/i.test((err && err.message) || '');
  }

  // --------------------------------------------------------- Tab Reimburse

  function renderReimburseTab(body) {
    if (reimburseRows.length === 0) {
      body.innerHTML =
        '<div class="empty-state"><div class="big">&#128178;</div>' +
        '<div>Belum ada pengajuan reimburse.</div></div>';
      return;
    }

    var columns = [
      {
        key: 'employee_name',
        label: 'Karyawan',
        render: function (r) {
          return '<strong>' + esc(r.employee_name) + '</strong><br><span class="small faint">' +
            esc(r.employee_code) + '</span>';
        },
      },
      {
        key: 'description',
        label: 'Deskripsi',
        render: function (r) {
          return esc(r.description || '-');
        },
      },
      {
        key: 'amount',
        label: 'Jumlah',
        render: function (r) {
          return 'Rp ' + esc(App.fmtNumber(r.amount || 0));
        },
      },
      {
        key: 'aksi',
        label: 'Aksi',
        align: 'right',
        render: function (r) {
          return (
            '<button class="btn sm success" data-rapprove="' + esc(r.id) + '">Setujui</button> ' +
            '<button class="btn sm danger" data-rreject="' + esc(r.id) + '">Tolak</button>'
          );
        },
      },
    ];

    body.innerHTML = App.table(columns, reimburseRows, {
      empty: 'Tidak ada pengajuan reimburse.',
    });

    body.querySelectorAll('[data-rapprove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        reviewReimburse(btn.getAttribute('data-rapprove'), 'approved');
      });
    });

    body.querySelectorAll('[data-rreject]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        reviewReimburse(btn.getAttribute('data-rreject'), 'rejected');
      });
    });
  }

  function reviewReimburse(id, status) {
    api
      .put('/employees/reimburses/' + id + '/review', { status: status })
      .then(function () {
        App.toast(
          status === 'approved' ? 'Reimburse disetujui.' : 'Reimburse ditolak.',
          'success'
        );
        loadData();
      })
      .catch(function (err) {
        App.toast(err.message, 'error');
      });
  }

  /** Riwayat reimburse beserta status, pemeriksa, dan waktunya. */
  function renderReimburseHistory(body) {
    var rows = filterHistory(reimburseHistory);

    var columns = [
      {
        key: 'employee_name',
        label: 'Karyawan',
        render: function (r) {
          return '<strong>' + esc(r.employee_name) + '</strong><br><span class="small faint">' +
            esc(r.employee_code) + '</span>';
        },
      },
      { key: 'description', label: 'Deskripsi', render: function (r) {
        return esc(r.description || '-');
      } },
      { key: 'amount', label: 'Jumlah', align: 'right', render: function (r) {
        return 'Rp ' + esc(App.fmtNumber(r.amount || 0));
      } },
      { key: 'status', label: 'Status', render: function (r) { return statusBadge(r.status); } },
      { key: 'reviewer', label: 'Pemeriksa', render: function (r) {
        return r.reviewer ? esc(r.reviewer) : '<span class="faint">-</span>';
      } },
      { key: 'reviewed_at', label: 'Diproses', render: function (r) {
        return r.reviewed_at ? esc(App.fmtDateTime(r.reviewed_at)) : '<span class="faint">-</span>';
      } },
      { key: 'created_at', label: 'Diajukan', render: function (r) {
        return r.created_at ? esc(App.fmtDateTime(r.created_at)) : '<span class="faint">-</span>';
      } },
      { key: 'attachment', label: 'Lampiran', render: function (r) {
        return r.attachment ? '<span class="small">Ada</span>' : '<span class="faint">-</span>';
      } },
    ];

    body.innerHTML = App.table(columns, rows, {
      empty: 'Belum ada riwayat reimburse.',
    });
  }

  // --------------------------------------------------------- Helpers

  function kv(label, value) {
    return '<div><div class="stat-label">' + esc(label) + '</div>' +
      '<div style="font-weight:600">' + (value ? esc(value) : '-') + '</div></div>';
  }
})();
