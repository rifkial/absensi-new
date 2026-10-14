/* =============================================================================
 * Halaman PAYROLL / PENGGAJIAN
 * - Periode payroll (draft/disetujui/dibayar)
 * - Komponen gaji (penghasilan/potongan/beban perusahaan)
 * - Gaji pokok & komponen per karyawan
 * - Detail + slip gaji siap cetak
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var tab = 'periods';
  var periods = [];
  var components = [];
  var employees = [];
  var currentPeriodId = null;
  var periodFilter = { status: '', year: '' };

  var TYPE_LABELS = {
    penghasilan: 'Penghasilan',
    potongan: 'Potongan',
    beban_perusahaan: 'Beban Perusahaan',
  };
  var METHOD_LABELS = {
    tetap: 'Nominal Tetap',
    persen: 'Persentase',
    manual: 'Manual (input per proses)',
    absensi: 'Berbasis Absensi',
    lembur: 'Per Jam Lembur',
  };
  var BASE_LABELS = {
    gaji_pokok: 'Gaji Pokok',
    bruto: 'Total Penghasilan (bruto)',
    tunjangan: 'Total Tunjangan',
    penghasilan_netto: 'Dasar Pajak',
  };
  var STATUS_LABELS = { draft: 'Draft', approved: 'Disetujui', paid: 'Dibayar' };
  var MONTHS = App.MONTH_NAMES;

  function fmtIdr(v) {
    return 'Rp ' + App.fmtNumber(Number(v) || 0);
  }

  window.Pages.payroll = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            tabBtn('periods', 'Periode Payroll') +
            tabBtn('components', 'Komponen Gaji') +
            tabBtn('employees', 'Gaji Karyawan') +
          '</div>' +
          '<div class="btn-group" id="pyActions"></div>' +
        '</div>' +
      '</div>' +
      '<div id="pyBody"></div>';

    root.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        currentPeriodId = null;
        window.Pages.payroll(root);
      });
    });

    if (tab === 'components') loadComponents();
    else if (tab === 'employees') loadEmployees();
    else loadPeriods();
  };

  function tabBtn(key, label) {
    return '<button class="btn ' + (tab === key ? 'primary' : '') + '" data-tab="' + key + '">' + esc(label) + '</button>';
  }

  function body() { return document.getElementById('pyBody'); }
  function actions() { return document.getElementById('pyActions'); }

  function setActions(html) {
    var el = actions();
    if (el) el.innerHTML = html;
  }

  // =============================================================== PERIODE

  function loadPeriods() {
    body().innerHTML = App.loading('Memuat periode payroll...');
    setActions(App.can('payroll:write') ? '<button class="btn primary" id="pyAddPeriod">+ Periode Baru</button>' : '');
    var add = document.getElementById('pyAddPeriod');
    if (add) add.addEventListener('click', openPeriodForm);

    api.get('/payroll/periods?' + toQuery(periodFilter))
      .then(function (res) {
        periods = res.data || [];
        paintPeriods();
      })
      .catch(function (err) { body().innerHTML = errBox(err); });
  }

  function toQuery(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function paintPeriods() {
    var yearOpts = '<option value="">Semua Tahun</option>';
    var seen = {};
    periods.forEach(function (p) {
      if (seen[p.period_year]) return;
      seen[p.period_year] = true;
      yearOpts += '<option value="' + p.period_year + '"' + (String(periodFilter.year) === String(p.period_year) ? ' selected' : '') + '>' + p.period_year + '</option>';
    });

    var filterHtml =
      '<div class="card"><div class="card-body"><div class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end">' +
        '<div class="field"><label>Status</label><select id="pyFilterStatus">' +
          '<option value="">Semua</option>' +
          ['draft', 'approved', 'paid'].map(function (s) {
            return '<option value="' + s + '"' + (periodFilter.status === s ? ' selected' : '') + '>' + esc(STATUS_LABELS[s]) + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>Tahun</label><select id="pyFilterYear">' + yearOpts + '</select></div>' +
        '<button class="btn" id="pyFilterReset">Reset</button>' +
      '</div></div></div>';

    var columns = [
      { key: 'label', label: 'Periode', render: function (r) {
        return '<strong>' + esc(r.label || (MONTHS[r.period_month - 1] + ' ' + r.period_year)) + '</strong>' +
          '<div class="small faint">' + esc(App.fmtDate(r.start_date)) + ' - ' + esc(App.fmtDate(r.end_date)) + '</div>';
      } },
      { key: 'status', label: 'Status', render: function (r) { return statusBadge(r.status); } },
      { key: 'total_items', label: 'Karyawan', align: 'right' },
      { key: 'total_earning', label: 'Total Penghasilan', align: 'right', render: function (r) { return fmtIdr(r.total_earning); } },
      { key: 'total_deduction', label: 'Total Potongan', align: 'right', render: function (r) { return fmtIdr(r.total_deduction); } },
      { key: 'total_net', label: 'Gaji Bersih', align: 'right', render: function (r) { return '<strong>' + fmtIdr(r.total_net) + '</strong>'; } },
{ key: 'aksi', label: 'Aksi', width: '220px', render: function (r) {
          return '<div class="btn-group">' +
            '<button class="btn sm" data-act="open" data-id="' + r.id + '">Buka</button>' +
            '<button class="btn sm" data-act="audit" data-id="' + r.id + '">Riwayat</button>' +
            (App.can('payroll:write') && r.status === 'draft'
              ? '<button class="btn sm danger" data-act="del" data-id="' + r.id + '">Hapus</button>' : '') +
          '</div>';
        } },
    ];

    body().innerHTML = filterHtml + '<div class="card"><div class="card-body tight">' + App.table(columns, periods, {
      empty: 'Belum ada periode payroll. Buat periode bulanan untuk mulai menghitung gaji.',
      emptyIcon: '&#128176;',
    }) + '</div></div>';

    var fs = document.getElementById('pyFilterStatus');
    if (fs) fs.addEventListener('change', function () { periodFilter.status = this.value; loadPeriods(); });
    var fy = document.getElementById('pyFilterYear');
    if (fy) fy.addEventListener('change', function () { periodFilter.year = this.value; loadPeriods(); });
    var fr = document.getElementById('pyFilterReset');
    if (fr) fr.addEventListener('click', function () { periodFilter = { status: '', year: '' }; loadPeriods(); });

    body().querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var act = b.getAttribute('data-act');
        if (act === 'open') openPeriod(id);
        else if (act === 'audit') openPeriodAudit(id, null);
        else deletePeriod(id);
      });
    });
  }

  function openPeriodAudit(periodId, itemId) {
    api.get('/payroll/periods/' + periodId + '/audit' + (itemId ? '?item_id=' + itemId : ''))
      .then(function (res) {
        var rows = res.data || [];
        var columns = [
          { key: 'created_at', label: 'Waktu', render: function (r) { return esc(App.fmtDateTime(r.created_at)); } },
          { key: 'action', label: 'Aksi', mono: true },
          { key: 'actor_name', label: 'Oleh', render: function (r) { return esc(r.actor_name || r.username || '-'); } },
          { key: 'detail', label: 'Detail', render: function (r) {
            if (!r.detail) return '<span class="faint">-</span>';
            var s = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
            return '<span class="small mono">' + esc(s.slice(0, 120)) + '</span>';
          } },
        ];
        App.modal({
          title: 'Riwayat Payroll',
          size: 'wide',
          bodyHtml: '<div class="card-body tight">' + App.table(columns, rows, { empty: 'Belum ada riwayat.', emptyIcon: '&#128337;' }) + '</div>',
          actions: [{ label: 'Tutup' }],
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function statusBadge(s) {
    var cls = s === 'paid' ? 'success' : (s === 'approved' ? 'info' : 'idle');
    return '<span class="badge ' + cls + '">' + esc(STATUS_LABELS[s] || s) + '</span>';
  }

  function openPeriodForm() {
    var now = new Date();
    var yearOpts = '';
    for (var y = now.getFullYear() - 2; y <= now.getFullYear() + 1; y += 1) {
      yearOpts += '<option value="' + y + '"' + (y === now.getFullYear() ? ' selected' : '') + '>' + y + '</option>';
    }
    var monthOpts = MONTHS.map(function (m, i) {
      return '<option value="' + (i + 1) + '"' + (i === now.getMonth() ? ' selected' : '') + '>' + m + '</option>';
    }).join('');

    App.modal({
      title: 'Periode Payroll Baru',
      bodyHtml:
        '<div class="callout">Satu periode = satu bulan penggajian. Setelah dibuat, hitung payroll untuk mengisi gaji karyawan.</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Bulan <span class="req">*</span></label><select id="pyMonth">' + monthOpts + '</select></div>' +
          '<div class="field"><label>Tahun <span class="req">*</span></label><select id="pyYear">' + yearOpts + '</select></div>' +
        '</div>' +
        '<div class="field mt"><label>Catatan</label><input type="text" id="pyNote" placeholder="opsional"></div>',
      actions: [
        { label: 'Batal' },
        { label: 'Buat Periode', className: 'primary', onClick: function (el) {
          api.post('/payroll/periods', {
            period_month: Number(el.querySelector('#pyMonth').value),
            period_year: Number(el.querySelector('#pyYear').value),
            note: el.querySelector('#pyNote').value.trim() || null,
          }).then(function (res) {
            App.toast('Periode dibuat.', 'success');
            el.closeModal();
            currentPeriodId = res.data.id;
            openPeriod(res.data.id);
          }).catch(function (err) { App.toast(err.message, 'error'); return false; });
          return false;
        } },
      ],
    });
  }

  function deletePeriod(id) {
    var p = periods.find(function (x) { return x.id === id; });
    App.confirm({
      title: 'Hapus periode',
      heading: 'Hapus periode ' + (p ? p.label : '') + '?',
      message: 'Seluruh item payroll pada periode ini akan dihapus. Tindakan ini tidak bisa dibatalkan.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/payroll/periods/' + id)
          .then(function () { App.toast('Periode dihapus.', 'success'); loadPeriods(); })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  function openPeriod(id) {
    currentPeriodId = id;
    body().innerHTML = App.loading('Memuat periode...');
    setActions('<button class="btn" id="pyBack">&#8592; Daftar Periode</button>');
    document.getElementById('pyBack').addEventListener('click', loadPeriods);

    api.get('/payroll/periods/' + id)
      .then(function (res) {
        paintPeriod(res.data.period, res.data.items || [], res.data.summary || {});
      })
      .catch(function (err) { body().innerHTML = errBox(err); });
  }

  function paintPeriod(period, items, summary) {
    var canWrite = App.can('payroll:write');
    var canApprove = App.can('payroll:approve');
    var draft = period.status === 'draft';

    var actionHtml = '';
    if (draft && canWrite) actionHtml += '<button class="btn primary" id="pyCalc">Hitung Payroll</button>';
    if (draft && canApprove) actionHtml += '<button class="btn success" id="pyApprove">Sahkan &amp; Kunci</button>';
    if (period.status === 'approved' && canApprove) actionHtml += '<button class="btn primary" id="pyPay">Tandai Dibayar</button>';
    if (period.status !== 'draft' && canApprove) actionHtml += '<button class="btn danger" id="pyReopen">Buka Kunci</button>';
    actionHtml += '<button class="btn success" id="pyExcel">&#11015; Excel</button>';
    actionHtml += '<button class="btn" id="pyCsv">&#11015; CSV</button>';
    actionHtml += '<button class="btn" id="pyAudit">Riwayat</button>';
    setActions(actionHtml);

    var summaryBar =
      '<div class="row" style="flex-wrap:wrap;gap:16px">' +
        summaryCell('Karyawan', App.formatNumber(summary.employees), '') +
        summaryCell('Total Penghasilan', fmtIdr(summary.total_earning), '') +
        summaryCell('Total Potongan', fmtIdr(summary.total_deduction), '') +
        summaryCell('Gaji Bersih', fmtIdr(summary.total_net), 'success') +
        summaryCell('Beban Perusahaan', fmtIdr(summary.total_company), 'info') +
      '</div>';

    var head =
      '<div class="card"><div class="card-body">' +
        '<div class="row" style="justify-content:space-between;align-items:center">' +
          '<div><h2 class="card-title">' + esc(period.label) + ' ' + statusBadge(period.status) + '</h2>' +
          '<p class="card-subtitle">' + esc(App.fmtDate(period.start_date)) + ' s.d. ' + esc(App.fmtDate(period.end_date)) + '</p></div>' +
        '</div>' +
        '<div class="mt">' + summaryBar + '</div>' +
      '</div></div>';

    var columns = [
      { key: 'employee_name', label: 'Karyawan', render: function (r) {
        return '<strong>' + esc(r.employee_name) + '</strong><div class="small faint mono">' + esc(r.employee_code) + ' · ' + esc(r.position_name || '-') + '</div>';
      } },
      { key: 'days_present', label: 'Hadir', align: 'right', render: function (r) { return r.days_present + '/' + r.days_work; } },
      { key: 'overtime_minutes', label: 'Lembur', align: 'right', render: function (r) { return App.fmtMinutes(r.overtime_minutes); } },
      { key: 'total_earning', label: 'Penghasilan', align: 'right', render: function (r) { return fmtIdr(r.total_earning); } },
      { key: 'total_deduction', label: 'Potongan', align: 'right', render: function (r) { return fmtIdr(r.total_deduction); } },
      { key: 'net_salary', label: 'Gaji Bersih', align: 'right', render: function (r) { return '<strong>' + fmtIdr(r.net_salary) + '</strong>'; } },
      { key: 'aksi', label: '', width: '160px', render: function (r) {
        return '<div class="btn-group"><button class="btn sm" data-slip="' + r.id + '">Slip</button>' +
          (draft && canWrite ? '<button class="btn sm primary" data-corr="' + r.id + '">Koreksi</button>' : '') + '</div>';
      } },
    ];

    body().innerHTML = head + '<div class="card"><div class="card-header"><div><h2 class="card-title">Rincian Perhitungan</h2>' +
      '<p class="card-subtitle">Angka absensi diambil dari modul absensi. Gaji bersih = total penghasilan - total potongan.</p></div>' +
      '<div class="field" style="min-width:220px;margin:0"><input type="text" id="pyItemSearch" placeholder="Cari nama / NIK..."></div></div>' +
      '<div class="card-body tight" id="pyItems">' + App.table(columns, items, { empty: 'Belum ada item. Klik "Hitung Payroll".', emptyIcon: '&#129534;' }) + '</div></div>';

    var searchEl = document.getElementById('pyItemSearch');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        var q = this.value.trim().toLowerCase();
        var filtered = !q ? items : items.filter(function (r) {
          return (r.employee_name || '').toLowerCase().indexOf(q) >= 0 || (r.employee_code || '').toLowerCase().indexOf(q) >= 0;
        });
        document.getElementById('pyItems').innerHTML = App.table(columns, filtered, { empty: 'Tidak ada yang cocok.', emptyIcon: '&#128269;' });
        wireItemButtons();
      });
    }

    function wireItemButtons() {
      body().querySelectorAll('button[data-slip]').forEach(function (b) {
        b.addEventListener('click', function () { showSlip(Number(b.getAttribute('data-slip'))); });
      });
      body().querySelectorAll('button[data-corr]').forEach(function (b) {
        b.addEventListener('click', function () { openCorrection(Number(b.getAttribute('data-corr'))); });
      });
    }
    wireItemButtons();

    bind('pyCalc', function () { calcPeriod(period); });
    bind('pyApprove', function () { simplePeriodAction('approve', period, 'Sahkan & kunci periode ini? Setelah disahkan, perhitungan tidak bisa diubah tanpa membuka kunci.'); });
    bind('pyPay', function () { simplePeriodAction('pay', period, 'Tandai periode ini sudah dibayar?'); });
    bind('pyReopen', function () { simplePeriodAction('reopen', period, 'Buka kunci periode kembali ke draft? Semua perubahan akan tercatat di riwayat.'); });
    bind('pyExcel', function () { downloadPeriod(period, 'excel'); });
    bind('pyCsv', function () { downloadPeriod(period, 'csv'); });
    bind('pyAudit', function () { openPeriodAudit(period.id, null); });
  }

  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  function summaryCell(label, value, cls) {
    return '<div><div class="small faint">' + esc(label) + '</div>' +
      '<div style="font-weight:600;font-size:16px" class="' + (cls ? 'text-' + cls : '') + '">' + esc(value) + '</div></div>';
  }

  function calcPeriod(period) {
    api.get('/payroll/periods/' + period.id + '/eligible')
      .then(function (res) {
        var list = res.data || [];
        var rows = list.map(function (e) {
          return '<label class="row" style="gap:8px;align-items:center;padding:4px 0">' +
            '<input type="checkbox" class="pyEmpPick" value="' + e.id + '"' + (e.payroll_enabled ? ' checked' : '') + '>' +
            '<span style="flex:1">' + esc(e.name) + ' <span class="small faint mono">' + esc(e.employee_code) + '</span></span>' +
            '<span class="small faint">' + e.work_days + ' hari · ' + fmtIdr(e.base_salary) + '</span>' +
            (e.already ? '<span class="badge info">sudah</span>' : '') +
          '</label>';
        }).join('');
        App.modal({
          title: 'Hitung Payroll - ' + period.label,
          size: 'wide',
          bodyHtml:
            '<div class="callout">Pilih karyawan yang dihitung. Karyawan dengan <strong>gaji pokok 0</strong> tetap dihitung; ' +
            'isi gaji pokok di tab "Gaji Karyawan" bila perlu.</div>' +
            '<div class="row" style="margin:8px 0;gap:8px">' +
              '<button class="btn sm" id="pyPickAll">Pilih semua</button>' +
              '<button class="btn sm" id="pyPickNone">Kosongkan</button>' +
              '<div class="grow"></div><span id="pyPickCount" class="small faint"></span>' +
            '</div>' +
            '<div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">' +
              (rows || '<div class="empty-state">Tidak ada karyawan layak.</div>') +
            '</div>',
          actions: [
            { label: 'Batal' },
            { label: 'Hitung', className: 'primary', onClick: function (el) {
              var ids = Array.prototype.map.call(el.querySelectorAll('.pyEmpPick:checked'), function (c) { return Number(c.value); });
              if (ids.length === 0) { App.toast('Pilih minimal satu karyawan.', 'error'); return false; }
              api.post('/payroll/periods/' + period.id + '/calc', { employee_ids: ids })
                .then(function (r) {
                  App.toast(r.data.calculated + ' karyawan dihitung.', 'success');
                  el.closeModal();
                  openPeriod(period.id);
                }).catch(function (err) { App.toast(err.message, 'error'); return false; });
              return false;
            } },
          ],
          onMount: function (el) {
            function upd() {
              var n = el.querySelectorAll('.pyEmpPick:checked').length;
              el.querySelector('#pyPickCount').textContent = n + ' dipilih';
            }
            el.querySelectorAll('.pyEmpPick').forEach(function (c) { c.addEventListener('change', upd); });
            el.querySelector('#pyPickAll').addEventListener('click', function () {
              el.querySelectorAll('.pyEmpPick').forEach(function (c) { c.checked = true; }); upd();
            });
            el.querySelector('#pyPickNone').addEventListener('click', function () {
              el.querySelectorAll('.pyEmpPick').forEach(function (c) { c.checked = false; }); upd();
            });
            upd();
          },
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function simplePeriodAction(kind, period, message) {
    App.confirm({
      title: 'Konfirmasi',
      heading: message,
      confirmLabel: 'Lanjutkan',
      danger: kind === 'reopen',
      onConfirm: function () {
        api.post('/payroll/periods/' + period.id + '/' + kind, {})
          .then(function (res) {
            App.toast(res.message || 'Berhasil.', 'success');
            openPeriod(period.id);
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  function downloadPeriod(period, kind) {
    api.download('/payroll/periods/' + period.id + '/export/' + kind)
      .then(function (res) {
        var url = URL.createObjectURL(res.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = res.filename || ('payroll.' + (kind === 'excel' ? 'xlsx' : 'csv'));
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        App.toast('Berkas diunduh.', 'success');
      })
      .catch(function (err) { App.toast('Gagal mengunduh: ' + err.message, 'error'); });
  }

  // --------------------------------------------------- Koreksi item

  function openCorrection(itemId) {
    api.get('/payroll/items/' + itemId)
      .then(function (res) {
        var item = res.data;
        var rowsHtml = item.lines.map(function (l) {
          return '<tr>' +
            '<td>' + esc(l.component_name) + '<div class="small faint">' + esc(TYPE_LABELS[l.type] || l.type) +
              (l.detail ? ' · ' + esc(l.detail) : '') + '</div></td>' +
            '<td class="num"><input type="number" class="pyLineAmt" data-id="' + l.id + '" value="' + l.amount + '" style="width:140px;text-align:right"></td>' +
          '</tr>';
        }).join('');
        App.modal({
          title: 'Koreksi: ' + item.employee_name,
          size: 'wide',
          bodyHtml:
            '<div class="callout warning">Ubah nominal baris di bawah untuk koreksi manual. Total akan dihitung ulang. ' +
            'Perubahan tercatat di riwayat.</div>' +
            '<div class="table-wrap"><table><thead><tr><th>Komponen</th><th class="num">Nominal</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody></table></div>' +
            '<div class="field mt"><label>Catatan koreksi</label><input type="text" id="pyCorrNote" value="' + esc(item.note || '') + '"></div>',
          actions: [
            { label: 'Batal' },
            { label: 'Simpan Koreksi', className: 'primary', onClick: function (el) {
              var lines = Array.prototype.map.call(el.querySelectorAll('.pyLineAmt'), function (inp) {
                return { id: Number(inp.getAttribute('data-id')), amount: App.parseRupiah(inp.value) };
              });
              api.put('/payroll/items/' + itemId, { lines: lines, note: el.querySelector('#pyCorrNote').value.trim() })
                .then(function () {
                  App.toast('Koreksi disimpan.', 'success');
                  el.closeModal();
                  openPeriod(currentPeriodId);
                }).catch(function (err) { App.toast(err.message, 'error'); return false; });
              return false;
            } },
          ],
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  // --------------------------------------------------- Slip

  function showSlip(itemId) {
    api.get('/payroll/items/' + itemId + '/slip')
      .then(function (res) {
        var slip = res.data;
        App.modal({
          title: 'Slip Gaji - ' + slip.employee.name,
          size: 'large',
          bodyHtml: '<div id="pySlipBox">' + slipHtml(slip) + '</div>',
          actions: [
            { label: 'Tutup' },
            { label: 'Cetak / PDF', className: 'primary', onClick: function () { printSlip(slip); return false; } },
          ],
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function slipRows(lines) {
    if (!lines.length) return '<tr><td colspan="2" class="faint">-</td></tr>';
    return lines.map(function (l) {
      return '<tr><td>' + esc(l.component_name) + (l.detail ? '<div class="small faint">' + esc(l.detail) + '</div>' : '') +
        '</td><td class="num">' + fmtIdr(l.amount) + '</td></tr>';
    }).join('');
  }

  function slipHtml(s) {
    return '' +
      '<div style="border:1px solid var(--border);border-radius:10px;padding:20px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e3a5f;padding-bottom:10px">' +
          '<div><div style="font-weight:700;font-size:18px;color:#1e3a5f">' + esc(s.company.name) + '</div>' +
          '<div class="small faint">' + esc(s.company.app_name) + '</div></div>' +
          '<div style="text-align:right"><div style="font-weight:700;letter-spacing:1px">SLIP GAJI KARYAWAN</div>' +
          '<div class="small">Periode: ' + esc(s.period.label) + '</div>' +
          '<div class="small faint">' + esc(STATUS_LABELS[s.period.status] || s.period.status) + '</div></div>' +
        '</div>' +
        '<div style="display:flex;gap:24px;margin:14px 0;flex-wrap:wrap">' +
          info('NIK', s.employee.employee_code) + info('Nama', s.employee.name) +
          info('Jabatan', s.employee.position_name || '-') + info('Unit Kerja', s.employee.department_name || '-') +
          info('Status', s.employee.status_label) + info('Hari Kerja', String(s.attendance.days_work)) +
        '</div>' +
        '<div class="grid-2">' +
          '<div><h4>Penghasilan</h4><table style="width:100%">' + slipRows(s.earnings) +
            '<tr style="font-weight:600"><td>Total Penghasilan (A)</td><td class="num">' + fmtIdr(s.totals.total_earning) + '</td></tr></table></div>' +
          '<div><h4>Potongan</h4><table style="width:100%">' + slipRows(s.deductions) +
            '<tr style="font-weight:600"><td>Total Potongan (B)</td><td class="num">' + fmtIdr(s.totals.total_deduction) + '</td></tr></table>' +
            (s.company_costs.length
              ? '<h5 class="mt">Beban Perusahaan (info)</h5><table style="width:100%">' + slipRows(s.company_costs) +
                '<tr style="font-weight:600"><td>Total</td><td class="num">' + fmtIdr(s.totals.total_company) + '</td></tr></table>'
              : '') +
          '</div>' +
        '</div>' +
        '<div style="margin-top:16px;padding-top:10px;border-top:2px solid #1e3a5f">' +
          '<div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700">' +
            '<span>PENERIMAAN BERSIH (A - B)</span><span>' + fmtIdr(s.totals.net_salary) + '</span></div>' +
          '<div class="small faint" style="font-style:italic">Terbilang: ' + esc(s.net_words) + '</div>' +
          (s.approval && s.approval.approved_by_name
            ? '<div class="small faint" style="margin-top:6px">Disetujui oleh ' + esc(s.approval.approved_by_name) +
              (s.approval.approved_at ? ' pada ' + esc(App.fmtDateTime(s.approval.approved_at)) : '') + '</div>'
            : '') +
        '</div>' +
      '</div>';
  }

  function info(label, value) {
    return '<div style="min-width:140px"><div class="small faint">' + esc(label) + '</div><div style="font-weight:600">' + esc(value) + '</div></div>';
  }

  function printSlip(s) {
    var w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { App.toast('Popup diblokir browser. Izinkan popup untuk mencetak.', 'error'); return; }
    var earnings = s.earnings.map(function (l) {
      return '<tr><td>' + esc(l.component_name) + '</td><td class="num">' + fmtIdr(l.amount) + '</td></tr>';
    }).join('');
    var deductions = s.deductions.map(function (l) {
      return '<tr><td>' + esc(l.component_name) + '</td><td class="num">' + fmtIdr(l.amount) + '</td></tr>';
    }).join('');
    var company = s.company_costs.map(function (l) {
      return '<tr><td>' + esc(l.component_name) + ' <span class="faint">(perusahaan)</span></td><td class="num">' + fmtIdr(l.amount) + '</td></tr>';
    }).join('');

    w.document.write(
      '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>Slip Gaji - ' + esc(s.employee.name) + '</title>' +
      '<style>' +
      '*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#111;font-size:12px}' +
      '.head{display:flex;justify-content:space-between;border-bottom:3px double #1e3a5f;padding-bottom:10px}' +
      '.co{font-size:18px;font-weight:700;color:#1e3a5f}.sub{color:#555}' +
      '.title{font-weight:700;letter-spacing:1px;text-align:right}.ident{margin:14px 0;font-size:12px}' +
      '.ident td{padding:2px 16px 2px 0}.cols{display:flex;gap:24px}.cols>div{flex:1}' +
      'table{width:100%;border-collapse:collapse;margin-top:4px}' +
      'td,th{padding:4px 6px;border-bottom:1px solid #ddd;text-align:left}' +
      '.num{text-align:right}.tot{font-weight:700;border-top:1px solid #999}' +
      'h4{margin:10px 0 2px;font-size:12px;text-transform:uppercase;color:#1e3a5f}' +
      '.net{display:flex;justify-content:space-between;font-size:15px;font-weight:700;border-top:3px double #1e3a5f;margin-top:14px;padding-top:8px}' +
      '.words{font-style:italic;color:#444;margin-top:4px}' +
      '.sign{margin-top:40px;display:flex;justify-content:space-between}' +
      '.sign div{text-align:center;border-top:1px solid #333;padding-top:4px;width:180px}' +
      '@media print{.noprint{display:none}}' +
      '</style></head><body>' +
      '<div class="head"><div><div class="co">' + esc(s.company.name) + '</div><div class="sub">' + esc(s.company.app_name) + '</div></div>' +
      '<div><div class="title">SLIP GAJI KARYAWAN</div><div class="sub">Periode: ' + esc(s.period.label) + '</div>' +
      '<div class="sub">Status: ' + esc(STATUS_LABELS[s.period.status] || s.period.status) + '</div></div></div>' +
      '<table class="ident"><tr>' +
        '<td><b>NIK</b><br>' + esc(s.employee.employee_code) + '</td>' +
        '<td><b>Nama</b><br>' + esc(s.employee.name) + '</td>' +
        '<td><b>Jabatan</b><br>' + esc(s.employee.position_name || '-') + '</td>' +
        '<td><b>Unit Kerja</b><br>' + esc(s.employee.department_name || '-') + '</td>' +
        '<td><b>Status</b><br>' + esc(s.employee.status_label) + '</td>' +
        '<td><b>Hari Kerja</b><br>' + esc(String(s.attendance.days_work)) + '</td>' +
      '</tr></table>' +
      '<div class="cols">' +
        '<div><h4>Penghasilan</h4><table>' + earnings +
          '<tr class="tot"><td>Total Penghasilan (A)</td><td class="num">' + fmtIdr(s.totals.total_earning) + '</td></tr></table></div>' +
        '<div><h4>Potongan</h4><table>' + deductions +
          '<tr class="tot"><td>Total Potongan (B)</td><td class="num">' + fmtIdr(s.totals.total_deduction) + '</td></tr></table>' +
          (company ? '<h4>Beban Perusahaan</h4><table>' + company +
          '<tr class="tot"><td>Total</td><td class="num">' + fmtIdr(s.totals.total_company) + '</td></tr></table>' : '') +
        '</div>' +
      '</div>' +
      '<div class="net"><span>PENERIMAAN BERSIH (A - B)</span><span>' + fmtIdr(s.totals.net_salary) + '</span></div>' +
      '<div class="words">Terbilang: ' + esc(s.net_words) + '</div>' +
      (s.approval && s.approval.approved_by_name
        ? '<div style="margin-top:4px;font-size:11px;color:#444">Disetujui oleh: ' + esc(s.approval.approved_by_name) +
          (s.approval.approved_at ? ' (' + esc(s.approval.approved_at) + ')' : '') + '</div>'
        : '') +
      '<div class="sign"><div>Penerima</div><div>Disetujui</div></div>' +
      '<div class="noprint" style="margin-top:20px;text-align:center"><button onclick="window.print()">Cetak / Simpan PDF</button></div>' +
      '</body></html>'
    );
    w.document.close();
    w.focus();
  }

  // =============================================================== KOMPONEN

  function loadComponents() {
    body().innerHTML = App.loading('Memuat komponen gaji...');
    setActions(App.can('payroll:write') ? '<button class="btn primary" id="pyAddComp">+ Komponen Baru</button>' : '');
    var add = document.getElementById('pyAddComp');
    if (add) add.addEventListener('click', function () { openComponentForm(null); });

    api.get('/payroll/components')
      .then(function (res) { components = res.data || []; paintComponents(); })
      .catch(function (err) { body().innerHTML = errBox(err); });
  }

  function paintComponents() {
    var columns = [
      { key: 'name', label: 'Komponen', render: function (r) {
        return '<strong>' + esc(r.name) + '</strong><div class="small faint mono">' + esc(r.code) + '</div>';
      } },
      { key: 'type', label: 'Jenis', render: function (r) {
        var cls = r.type === 'penghasilan' ? 'success' : (r.type === 'potongan' ? 'failed' : 'info');
        return '<span class="badge ' + cls + '">' + esc(TYPE_LABELS[r.type] || r.type) + '</span>';
      } },
      { key: 'calc_method', label: 'Metode', render: function (r) {
        var txt = METHOD_LABELS[r.calc_method] || r.calc_method;
        if (r.calc_method === 'persen') txt += ' (' + (r.percent || 0) + '% dari ' + (BASE_LABELS[r.percent_base] || r.percent_base || '-') + ')';
        else if (r.calc_method === 'tetap' || r.calc_method === 'manual') txt += r.amount ? ' (' + fmtIdr(r.amount) + ')' : '';
        return esc(txt);
      } },
      { key: 'taxable', label: 'Kena Pajak', align: 'right', render: function (r) { return r.taxable ? 'Ya' : '-'; } },
      { key: 'is_active', label: 'Status', render: function (r) {
        return r.is_active ? '<span class="badge success">Aktif</span>' : '<span class="badge idle">Nonaktif</span>';
      } },
      { key: 'aksi', label: '', width: '140px', render: function (r) {
        if (!App.can('payroll:write')) return '';
        return '<div class="btn-group"><button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' +
          '<button class="btn sm danger" data-act="del" data-id="' + r.id + '">Hapus</button></div>';
      } },
    ];
    body().innerHTML = '<div class="card"><div class="card-header"><div><h2 class="card-title">Komponen Gaji</h2>' +
      '<p class="card-subtitle">Penghasilan menambah gaji, potongan mengurangi, beban perusahaan hanya info biaya.</p></div></div>' +
      '<div class="card-body tight">' + App.table(columns, components, { empty: 'Belum ada komponen.', emptyIcon: '&#129531;' }) + '</div></div>';

    body().querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        if (b.getAttribute('data-act') === 'edit') openComponentForm(components.find(function (c) { return c.id === id; }));
        else deleteComponent(id);
      });
    });
  }

  function ruleToJsonString(rule) {
    if (!rule) return '';
    if (typeof rule === 'string') return rule;
    var parts = [];
    Object.keys(rule).forEach(function (k) { if (Number(rule[k])) parts.push(k + '=' + rule[k]); });
    return parts.join(', ');
  }

  function openComponentForm(comp) {
    var isEdit = Boolean(comp);
    var rule = comp && comp.rule_json && typeof comp.rule_json === 'object' ? comp.rule_json : {};

    App.modal({
      title: isEdit ? 'Ubah Komponen' : 'Komponen Gaji Baru',
      size: 'wide',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field"><label>Kode <span class="req">*</span></label><input type="text" id="pcCode" value="' + esc(isEdit ? comp.code : '') + '" ' + (isEdit ? 'disabled' : '') + ' placeholder="mis. TJ_TRANSPORT"></div>' +
          '<div class="field"><label>Nama <span class="req">*</span></label><input type="text" id="pcName" value="' + esc(isEdit ? comp.name : '') + '" placeholder="mis. Tunjangan Transport"></div>' +
          '<div class="field"><label>Jenis <span class="req">*</span></label><select id="pcType">' +
            ['penghasilan', 'potongan', 'beban_perusahaan'].map(function (t) {
              return '<option value="' + t + '"' + (isEdit && comp.type === t ? ' selected' : '') + '>' + TYPE_LABELS[t] + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field"><label>Kategori</label><input type="text" id="pcCategory" value="' + esc(isEdit ? comp.category : 'lainnya') + '"></div>' +
          '<div class="field"><label>Metode Hitung <span class="req">*</span></label><select id="pcMethod">' +
            Object.keys(METHOD_LABELS).map(function (m) {
              return '<option value="' + m + '"' + (isEdit && comp.calc_method === m ? ' selected' : '') + '>' + METHOD_LABELS[m] + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field" id="pcAmountWrap"><label>Nominal (Rp)</label><input type="text" id="pcAmount" value="' + esc(isEdit ? comp.amount : 0) + '" class="rupiah"></div>' +
          '<div class="field" id="pcPercentWrap"><label>Persentase (%)</label><input type="number" step="0.0001" id="pcPercent" value="' + esc(isEdit && comp.percent !== null ? comp.percent : '') + '"></div>' +
          '<div class="field" id="pcBaseWrap"><label>Dasar Persen</label><select id="pcBase">' +
            '<option value="">-</option>' +
            Object.keys(BASE_LABELS).map(function (b) {
              return '<option value="' + b + '"' + (isEdit && comp.percent_base === b ? ' selected' : '') + '>' + BASE_LABELS[b] + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field" id="pcRuleWrap" style="grid-column:1/-1"><label>Aturan Absensi/Lembur</label>' +
            '<input type="text" id="pcRule" value="' + esc(ruleToJsonString(rule)) + '" placeholder="mis. per_hadir=20000, per_alpa=50000, per_terlambat=10000, per_jam=25000">' +
            '<span class="help">Format kunci=nilai, pisah koma. Kunci: per_hadir, per_hari_kerja, per_terlambat, per_alpa, per_izin, per_jam.</span></div>' +
        '</div>' +
        '<div class="divider"></div>' +
        '<div class="row" style="gap:20px;flex-wrap:wrap">' +
          '<div class="field checkbox"><input type="checkbox" id="pcTaxable"' + (isEdit && comp.taxable ? ' checked' : '') + '><label for="pcTaxable">Masuk dasar PPh 21</label></div>' +
          '<div class="field checkbox"><input type="checkbox" id="pcBpjs"' + (isEdit && comp.bpjs_base ? ' checked' : '') + '><label for="pcBpjs">Masuk dasar iuran BPJS</label></div>' +
          '<div class="field checkbox"><input type="checkbox" id="pcActive"' + (!isEdit || comp.is_active ? ' checked' : '') + '><label for="pcActive">Aktif</label></div>' +
        '</div>',
      actions: [
        { label: 'Batal' },
        { label: 'Simpan', className: 'primary', onClick: function (el) {
          var method = el.querySelector('#pcMethod').value;
          var rule = parseRuleInput(el.querySelector('#pcRule').value);
          var payload = {
            code: el.querySelector('#pcCode').value.trim(),
            name: el.querySelector('#pcName').value.trim(),
            type: el.querySelector('#pcType').value,
            category: el.querySelector('#pcCategory').value.trim() || 'lainnya',
            calc_method: method,
            amount: App.parseRupiah(el.querySelector('#pcAmount').value),
            percent: el.querySelector('#pcPercent').value === '' ? null : Number(el.querySelector('#pcPercent').value),
            percent_base: el.querySelector('#pcBase').value || null,
            rule_json: rule,
            taxable: el.querySelector('#pcTaxable').checked ? 1 : 0,
            bpjs_base: el.querySelector('#pcBpjs').checked ? 1 : 0,
            is_active: el.querySelector('#pcActive').checked ? 1 : 0,
          };
          if (!payload.code || !payload.name) { App.toast('Kode dan nama wajib diisi.', 'error'); return false; }
          var req = isEdit ? api.put('/payroll/components/' + comp.id, payload) : api.post('/payroll/components', payload);
          req.then(function () {
            App.toast(isEdit ? 'Komponen diperbarui.' : 'Komponen dibuat.', 'success');
            el.closeModal();
            loadComponents();
          }).catch(function (err) { App.toast(err.message, 'error'); return false; });
          return false;
        } },
      ],
      onMount: function (el) {
        App.bindRupiah(el.querySelector('#pcAmount'));
        function sync() {
          var m = el.querySelector('#pcMethod').value;
          el.querySelector('#pcAmountWrap').style.display = (m === 'tetap' || m === 'manual') ? '' : 'none';
          el.querySelector('#pcPercentWrap').style.display = m === 'persen' ? '' : 'none';
          el.querySelector('#pcBaseWrap').style.display = m === 'persen' ? '' : 'none';
          el.querySelector('#pcRuleWrap').style.display = (m === 'absensi' || m === 'lembur') ? '' : 'none';
        }
        el.querySelector('#pcMethod').addEventListener('change', sync);
        sync();
      },
    });
  }

  function parseRuleInput(text) {
    var out = {};
    String(text || '').split(',').forEach(function (pair) {
      var m = /^\s*([a-z_]+)\s*=\s*([\d.]+)\s*$/i.exec(pair);
      if (m) out[m[1]] = Number(m[2].replace(/\./g, ''));
    });
    return Object.keys(out).length ? out : null;
  }

  function deleteComponent(id) {
    App.confirm({
      title: 'Hapus komponen',
      heading: 'Hapus komponen ini?',
      message: 'Komponen yang sudah dipakai slip akan dinonaktifkan, bukan dihapus.',
      danger: true, confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/payroll/components/' + id)
          .then(function (res) { App.toast(res.deactivated ? 'Komponen dinonaktifkan.' : 'Komponen dihapus.', 'success'); loadComponents(); })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  // =============================================================== GAJI KARYAWAN

  function loadEmployees() {
    body().innerHTML = App.loading('Memuat data gaji karyawan...');
    setActions('');
    api.get('/payroll/employees')
      .then(function (res) { employees = res.data || []; paintEmployees(); })
      .catch(function (err) { body().innerHTML = errBox(err); });
  }

  function paintEmployees() {
    var columns = [
      { key: 'name', label: 'Karyawan', render: function (r) {
        return '<strong>' + esc(r.name) + '</strong><div class="small faint mono">' + esc(r.employee_code) + '</div>';
      } },
      { key: 'department_name', label: 'Unit Kerja' },
      { key: 'position_name', label: 'Jabatan' },
      { key: 'base_salary', label: 'Gaji Pokok', align: 'right', render: function (r) { return fmtIdr(r.base_salary); } },
      { key: 'payroll_enabled', label: 'Ikut Payroll', render: function (r) {
        return r.payroll_enabled ? '<span class="badge success">Ya</span>' : '<span class="badge idle">Tidak</span>';
      } },
      { key: 'aksi', label: '', width: '120px', render: function (r) {
        return App.can('payroll:write') ? '<button class="btn sm primary" data-id="' + r.id + '">Atur</button>' : '';
      } },
    ];
    body().innerHTML = '<div class="card"><div class="card-header"><div><h2 class="card-title">Gaji Pokok & Komponen Karyawan</h2>' +
      '<p class="card-subtitle">Gaji pokok dan override komponen per karyawan.</p></div></div>' +
      '<div class="card-body tight">' + App.table(columns, employees, { empty: 'Belum ada karyawan aktif.', emptyIcon: '&#128101;' }) + '</div></div>';

    body().querySelectorAll('button[data-id]').forEach(function (b) {
      b.addEventListener('click', function () { openEmployeeSalary(Number(b.getAttribute('data-id'))); });
    });
  }

  function openEmployeeSalary(employeeId) {
    api.get('/payroll/employees/' + employeeId)
      .then(function (res) {
        var d = res.data;
        var salary = d.salary || { base_salary: 0, payroll_enabled: 1 };
        var overrideById = {};
        (d.overrides || []).forEach(function (o) { overrideById[o.component_id] = o; });

        var compRows = (d.components || []).map(function (c) {
          var o = overrideById[c.id];
          return '<tr>' +
            '<td>' + esc(c.name) + '<div class="small faint">' + esc(TYPE_LABELS[c.type]) + ' · ' + esc(METHOD_LABELS[c.calc_method]) + '</div></td>' +
            '<td class="num">' + (c.calc_method === 'persen' ? (c.percent || 0) + '%' : fmtIdr(c.amount)) + '</td>' +
            '<td class="num"><input type="number" class="pyOvAmt" data-cid="' + c.id + '" value="' + ((o && o.amount !== null) ? o.amount : '') + '" placeholder="' + c.amount + '" style="width:120px;text-align:right"></td>' +
            '<td class="num"><input type="number" step="0.0001" class="pyOvPct" data-cid="' + c.id + '" value="' + ((o && o.percent !== null) ? o.percent : '') + '" placeholder="' + (c.percent || '') + '" style="width:90px;text-align:right"></td>' +
          '</tr>';
        }).join('');

        App.modal({
          title: 'Gaji: ' + d.employee.name,
          size: 'wide',
          bodyHtml:
            '<div class="form-grid">' +
              '<div class="field"><label>Gaji Pokok (Rp)</label><input type="text" id="pyBase" class="rupiah" value="' + (salary.base_salary || 0) + '"></div>' +
              '<div class="field checkbox" style="align-self:end"><input type="checkbox" id="pyEnabled"' + (salary.payroll_enabled ? ' checked' : '') + '><label for="pyEnabled">Ikut payroll massal</label></div>' +
            '</div>' +
            '<div class="divider"></div>' +
            '<p class="small muted">Kosongkan kolom override untuk memakai nilai master. Isi nominal/persen untuk menyesuaikan komponen khusus karyawan ini.</p>' +
            '<div class="table-wrap"><table><thead><tr><th>Komponen</th><th class="num">Master</th><th class="num">Nominal Override</th><th class="num">Persen Override</th></tr></thead>' +
            '<tbody>' + (compRows || '<tr><td colspan="4" class="faint">Belum ada komponen aktif.</td></tr>') + '</tbody></table></div>',
          actions: [
            { label: 'Tutup' },
            { label: 'Simpan', className: 'primary', onClick: function (el) {
              saveEmployeeSalary(el, employeeId);
              return false;
            } },
          ],
          onMount: function (el) { App.bindRupiah(el.querySelector('#pyBase')); },
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function saveEmployeeSalary(el, employeeId) {
    var base = App.parseRupiah(el.querySelector('#pyBase').value);
    var enabled = el.querySelector('#pyEnabled').checked ? 1 : 0;

    var sets = [];
    var clears = [];
    el.querySelectorAll('.pyOvAmt').forEach(function (inp) {
      var cid = Number(inp.getAttribute('data-cid'));
      var pct = el.querySelector('.pyOvPct[data-cid="' + cid + '"]').value;
      var amt = inp.value.trim() === '' ? null : App.parseRupiah(inp.value);
      var p = pct.trim() === '' ? null : Number(pct);
      if (amt === null && p === null) clears.push(cid);
      else sets.push({ component_id: cid, amount: amt, percent: p });
    });

    api.put('/payroll/employees/' + employeeId + '/salary', { base_salary: base, payroll_enabled: enabled })
      .then(function () {
        return Promise.all([
          ...sets.map(function (o) { return api.post('/payroll/employees/' + employeeId + '/components', o); }),
          ...clears.map(function (cid) { return api.del('/payroll/employees/' + employeeId + '/components/' + cid); }),
        ]);
      })
      .then(function () {
        App.toast('Data gaji disimpan.', 'success');
        el.closeModal();
        loadEmployees();
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function errBox(err) {
    return '<div class="card"><div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div></div>';
  }
})();
