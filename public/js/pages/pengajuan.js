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

  window.Pages.pengajuanRefresh = function () {
    if (document.getElementById('pjBody')) loadData();
  };

  window.Pages.pengajuan = function (root) {
    root.innerHTML =
      '<div class="card"><div class="card-header">' +
        '<h2 class="card-title">Pengajuan Karyawan</h2>' +
        '<div class="btn-group">' +
          TABS.map(function (t) {
            return '<button class="btn sm" data-tab="' + esc(t.key) + '">' + esc(t.label) + '</button>';
          }).join('') +
          (App.can('attendance:write')
            ? '<button class="btn sm primary" data-new="1">+ Input Pengajuan</button>' +
              '<button class="btn sm" data-new-rb="1">+ Input Reimburse</button>'
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
    var newRbBtn = root.querySelector('[data-new-rb]');
    if (newRbBtn) newRbBtn.addEventListener('click', openReimburseForm);

    root.querySelector('[data-tab="leave"]').classList.add('primary');

    loadData();
  };

  // ------------------------------------------------- Input pengajuan (admin/HR)

  /** Input reimburse multi-baris atas nama karyawan. */
  function openReimburseForm() {
    if (!App.can('attendance:write')) {
      App.toast('Anda tidak punya hak untuk input reimburse.', 'error');
      return;
    }
    api.get('/employees/options/list')
      .then(function (res) {
        var employees = res.data || [];
        if (employees.length === 0) {
          App.toast('Belum ada karyawan aktif.', 'error');
          return;
        }
        var empOptions = employees.map(function (e) {
          return '<option value="' + esc(e.id) + '">' + esc(e.employee_code + ' - ' + e.name) + '</option>';
        }).join('');
        App.modal({
          title: 'Input Reimburse (Admin/HR)',
          size: 'wide',
          bodyHtml:
            '<div class="field"><label>Karyawan <span class="req">*</span></label>' +
              '<select id="rbEmp">' + empOptions + '</select></div>' +
            '<div class="callout mt">Tambah baris bila ada banyak biaya. Tiap baris boleh lampirkan bukti sendiri.</div>' +
            '<div id="rbRows"></div>' +
            '<button type="button" class="btn sm" id="rbAdd">+ Tambah Biaya</button>' +
            '<div class="small faint mt" id="rbTotal">Total: Rp 0</div>',
          actions: [
            { label: 'Batal' },
            {
              label: 'Simpan Reimburse',
              className: 'primary',
              onClick: function (el) {
                var employeeId = el.querySelector('#rbEmp').value;
                if (!employeeId) { App.toast('Karyawan wajib dipilih.', 'error'); return false; }
                var rows = el.querySelectorAll('.rb-row');
                if (rows.length === 0) { App.toast('Tambah minimal satu biaya.', 'error'); return false; }
                var items = [];
                var fd = new FormData();
                fd.append('employee_id', employeeId);
                var total = 0;
                for (var i = 0; i < rows.length; i += 1) {
                  var desc = rows[i].querySelector('.rb-desc').value.trim();
                  var amount = App.parseRupiah(rows[i].querySelector('.rb-amount').value);
                  var file = rows[i].querySelector('.rb-file').files[0];
                  if (!desc) { App.toast('Baris ' + (i + 1) + ': deskripsi wajib diisi.', 'error'); return false; }
                  if (!amount || amount <= 0) { App.toast('Baris ' + (i + 1) + ': jumlah harus > 0.', 'error'); return false; }
                  if (file && file.size > 10 * 1024 * 1024) { App.toast('Baris ' + (i + 1) + ': bukti maksimal 10 MB.', 'error'); return false; }
                  items.push({ description: desc, amount: amount });
                  if (file) fd.append('receipts[' + i + ']', file, file.name);
                  total += amount;
                }
                fd.append('items', JSON.stringify(items));
                api.upload('/employees/reimburses/batch', fd)
                  .then(function (res) {
                    App.toast((res.count || items.length) + ' reimburse tersimpan (Rp ' + App.fmtNumber(total) + ').', 'success');
                    el.closeModal();
                    loadData();
                  })
                  .catch(function (err) { App.toast(err.message, 'error'); });
                return false;
              },
            },
          ],
          onMount: function (backdrop) {
            var list = backdrop.querySelector('#rbRows');
            var totalEl = backdrop.querySelector('#rbTotal');
            function updateTotal() {
              var sum = 0;
              Array.prototype.forEach.call(backdrop.querySelectorAll('.rb-amount'), function (input) {
                sum += App.parseRupiah(input.value) || 0;
              });
              totalEl.textContent = 'Total: Rp ' + App.fmtNumber(sum) + ' (' + backdrop.querySelectorAll('.rb-row').length + ' item)';
            }
            function addRow() {
              var div = document.createElement('div');
              div.className = 'rb-row card-body';
              div.style.cssText = 'border:1px solid var(--border);border-radius:8px;margin-bottom:8px';
              div.innerHTML =
                '<div class="form-grid">' +
                  '<div class="field"><label>Deskripsi <span class="req">*</span></label>' +
                    '<input type="text" class="rb-desc" maxlength="500" placeholder="BBM, tol, parkir..."></div>' +
                  '<div class="field"><label>Jumlah (Rp) <span class="req">*</span></label>' +
                    '<div class="row"><span class="small faint">Rp</span>' +
                    '<input type="text" class="rb-amount" inputmode="numeric" placeholder="50.000" style="flex:1"></div></div>' +
                '</div>' +
                '<div class="field mt"><label>Bukti (opsional)</label>' +
                  '<input type="file" class="rb-file" accept="image/jpeg,image/png,image/webp,application/pdf"></div>' +
                '<div class="row mt"><button type="button" class="btn sm danger rb-del">Hapus</button></div>';
              div.querySelector('.rb-del').addEventListener('click', function () { div.remove(); updateTotal(); });
              var amountInput = div.querySelector('.rb-amount');
              App.bindRupiah(amountInput);
              amountInput.addEventListener('input', updateTotal);
              list.appendChild(div);
              updateTotal();
            }
            backdrop.querySelector('#rbAdd').addEventListener('click', addRow);
            addRow();
          },
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

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
            '</select>' +
            '<div class="btn-group">' +
              '<button class="btn sm" id="pjPrint">Cetak</button>' +
              '<button class="btn sm" id="pjExcel">Excel</button>' +
              (currentTab === 'leave' && App.can('attendance:write')
                ? '<button class="btn sm" id="pjTemplate">Template</button>' +
                  '<button class="btn sm" id="pjImport">Impor</button>' : '') +
            '</div>' +
            '<input type="file" id="pjImportFile" accept=".csv,.xlsx,.xls" hidden>'
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

    var printBtn = document.getElementById('pjPrint');
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

    var excelBtn = document.getElementById('pjExcel');
    if (excelBtn) {
      excelBtn.addEventListener('click', function () {
        var tab = currentTab === 'reimburse' ? 'reimburse' : 'leave';
        var status = historyStatus === 'all' ? 'all' : historyStatus;
        api.download('/employees/history/export/excel', { tab: tab, status: status, limit: 2000 })
          .then(function (res) {
            var url = URL.createObjectURL(res.blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = res.filename || ('riwayat-' + tab + '.xlsx');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
            App.toast('Excel riwayat diunduh.', 'success');
          })
          .catch(function (err) { App.toast('Gagal mengunduh: ' + err.message, 'error'); });
      });
    }

    var templateBtn = document.getElementById('pjTemplate');
    if (templateBtn) {
      templateBtn.addEventListener('click', function () {
        var csv = 'employee_code,subtype,start_date,end_date,place,reason,status\n' +
          '001,dinas_luar_kota,2026-10-06,2026-10-08,Surabaya,Rapat koordinator,pending\n' +
          '002,cuti_tahunan,2026-10-10,2026-10-11,,,pending\n';
        var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'template-riwayat-pengajuan.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      });
    }

    var importBtn = document.getElementById('pjImport');
    var importFile = document.getElementById('pjImportFile');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function () {
        var file = importFile.files && importFile.files[0];
        if (!file) return;
        var fd = new FormData();
        fd.append('file', file, file.name);
        importBtn.disabled = true;
        api.upload('/employees/history/import', fd)
          .then(function (res) {
            var d = res.data || {};
            App.toast(
              d.inserted + ' baris diimpor' + (d.skipped ? ', ' + d.skipped + ' dilewati.' : '.') +
              ((d.errors && d.errors[0]) ? ' Contoh: baris ' + d.errors[0].baris + ' (' + d.errors[0].pesan + ').' : ''),
              d.skipped ? 'warning' : 'success'
            );
            loadData();
          })
          .catch(function (err) { App.toast(err.message, 'error'); })
          .then(function () {
            importBtn.disabled = false;
            importFile.value = '';
          });
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

  /** Tanggal pengajuan reimburse (YYYY-MM-DD dari created_at). */
  function reimburseDate(r) {
    return String(r.created_at || '').slice(0, 10) || '-';
  }

  /** Render tabel reimburse dengan kolom tanggal + rowspan tanggal sama. */
  function reimburseTable(rows, opts) {
    var o = opts || {};
    if (!rows || rows.length === 0) {
      return '<div class="empty-state"><div class="big">&#128178;</div>' +
        '<div>' + esc(o.empty || 'Tidak ada pengajuan reimburse.') + '</div></div>';
    }

    var sorted = rows.slice().sort(function (a, b) {
      var d = String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
      if (String(a.created_at || '') === String(b.created_at || '')) d = 0;
      return d;
    });

    var head =
      '<tr><th>Tanggal</th><th>Karyawan</th><th>Deskripsi</th>' +
      '<th class="num">Jumlah</th><th>Bukti</th>' +
      (o.history ? '<th>Status</th><th>Pemeriksa</th><th>Diproses</th><th>Diajukan</th>' : '<th class="num">Aksi</th>') +
      '</tr>';

    var htmlRows = '';
    var i = 0;
    while (i < sorted.length) {
      var date = reimburseDate(sorted[i]);
      var j = i;
      while (j < sorted.length && reimburseDate(sorted[j]) === date) j += 1;
      var span = j - i;

      for (var k = i; k < j; k += 1) {
        var r = sorted[k];
        var cells = '';
        if (k === i) {
          cells += '<td rowspan="' + span + '" class="nowrap"><strong>' + esc(App.fmtDate(date)) + '</strong>' +
            '<br><span class="small faint">' + span + ' item</span></td>';
        }
        cells += '<td><strong>' + esc(r.employee_name) + '</strong><br><span class="small faint">' +
          esc(r.employee_code) + '</span></td>';
        cells += '<td>' + esc(r.description || '-') + '</td>';
        cells += '<td class="num">Rp ' + esc(App.fmtNumber(r.amount || 0)) + '</td>';
        cells += '<td>' + (r.receipt_url
          ? '<button class="btn sm" data-receipt="' + esc(r.receipt_url) + '">Lihat</button>'
          : '<span class="faint">-</span>') + '</td>';
        if (o.history) {
          cells += '<td>' + statusBadge(r.status) + '</td>';
          cells += '<td>' + (r.reviewer ? esc(r.reviewer) : '<span class="faint">-</span>') + '</td>';
          cells += '<td>' + (r.reviewed_at ? esc(App.fmtDateTime(r.reviewed_at)) : '<span class="faint">-</span>') + '</td>';
          cells += '<td>' + (r.created_at ? esc(App.fmtDateTime(r.created_at)) : '<span class="faint">-</span>') + '</td>';
        } else {
          cells += '<td class="num">' +
            '<button class="btn sm success" data-rapprove="' + esc(r.id) + '">Setujui</button> ' +
            '<button class="btn sm danger" data-rreject="' + esc(r.id) + '">Tolak</button></td>';
        }
        htmlRows += '<tr>' + cells + '</tr>';
      }
      i = j;
    }

    return '<div class="table-wrap"><table><thead>' + head + '</thead><tbody>' + htmlRows + '</tbody></table></div>';
  }

  function renderReimburseTab(body) {
    if (reimburseRows.length === 0) {
      body.innerHTML =
        '<div class="empty-state"><div class="big">&#128178;</div>' +
        '<div>Belum ada pengajuan reimburse.</div></div>';
      return;
    }

    body.innerHTML = reimburseTable(reimburseRows, { empty: 'Tidak ada pengajuan reimburse.' });

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

    body.querySelectorAll('[data-receipt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openReimburseReceipt(btn.getAttribute('data-receipt'));
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

    body.innerHTML = reimburseTable(rows, { history: true, empty: 'Belum ada riwayat reimburse.' });

    body.querySelectorAll('[data-receipt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openReimburseReceipt(btn.getAttribute('data-receipt'));
      });
    });
  }

  /** Buka bukti reimburse admin: gambar modal, PDF tab baru. */
  function openReimburseReceipt(url) {
    fetch(url, { headers: { Authorization: 'Bearer ' + api.token } })
      .then(function (res) {
        if (!res.ok) throw new Error('Bukti tidak dapat dimuat (' + res.status + ').');
        var type = res.headers.get('content-type') || '';
        return res.blob().then(function (blob) { return { blob: blob, type: type }; });
      })
      .then(function (r) {
        var objectUrl = URL.createObjectURL(r.blob);
        if (/pdf/i.test(r.type)) {
          window.open(objectUrl, '_blank');
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
          return;
        }
        App.modal({
          title: 'Bukti Reimburse',
          bodyHtml: '<img src="' + objectUrl + '" alt="Bukti reimburse" style="width:100%;border-radius:8px">',
          actions: [{ label: 'Tutup' }],
          onClose: function () { URL.revokeObjectURL(objectUrl); },
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  // --------------------------------------------------------- Helpers

  function kv(label, value) {
    return '<div><div class="stat-label">' + esc(label) + '</div>' +
      '<div style="font-weight:600">' + (value ? esc(value) : '-') + '</div></div>';
  }
})();
