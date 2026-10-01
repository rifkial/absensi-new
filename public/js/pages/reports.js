/* =============================================================================
 * Halaman LAPORAN
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var state = {
    format: 'rekap_harian',
    from: App.startOfMonth(),
    to: App.today(),
    month: App.today().slice(0, 7),
    department_id: '',
    employee_id: '',
    status: '',
  };

  var FORMATS = [
    { key: 'rekap_harian', label: 'Rekap Harian (per karyawan per tanggal)' },
    { key: 'rekap_bulanan', label: 'Rekap Bulanan (per karyawan)' },
    { key: 'per_karyawan', label: 'Rekap per Karyawan (ringkas)' },
    { key: 'log_mentah', label: 'Log Absensi Mentah' },
    { key: 'ringkasan', label: 'Ringkasan per Hari' },
  ];

  window.Pages.reports = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Laporan Absensi</h2>' +
          '<p class="card-subtitle">Pratinjau di layar, unduh sebagai Excel atau CSV</p></div>' +
          '<div class="btn-group">' +
            '<button class="btn" id="repPreview">Tampilkan</button>' +
            '<button class="btn success" id="repExcel">&#11015; Excel</button>' +
            '<button class="btn" id="repCsv">&#11015; CSV</button>' +
            '<button class="btn" id="repPrint">&#128424; Cetak</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="form-grid">' +
            '<div class="field"><label>Jenis Laporan <span class="req">*</span></label><select id="rpFormat">' +
              FORMATS.map(function (f) {
                return '<option value="' + f.key + '"' + (state.format === f.key ? ' selected' : '') + '>' + esc(f.label) + '</option>';
              }).join('') +
            '</select></div>' +
            '<div class="field" id="wrapFrom"><label>Dari Tanggal</label><input type="date" id="rpFrom" value="' + esc(state.from) + '"></div>' +
            '<div class="field" id="wrapTo"><label>Sampai Tanggal</label><input type="date" id="rpTo" value="' + esc(state.to) + '"></div>' +
            '<div class="field" id="wrapMonth"><label>Bulan</label><input type="month" id="rpMonth" value="' + esc(state.month) + '"></div>' +
            '<div class="field"><label>Unit Kerja</label><select id="rpDept"><option value="">Semua</option></select></div>' +
            '<div class="field"><label>Status</label><select id="rpStatus"><option value="">Semua</option>' +
['hadir', 'telat', 'dinas_luar', 'izin', 'sakit', 'cuti', 'alpa', 'belum', 'hari_libur'].map(function (s) {
    return '<option value="' + s + '">' + esc(App.STATUS_LABELS[s] || s) + '</option>';
              }).join('') +
            '</select></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title" id="repTitle">Hasil Laporan</h2>' +
          '<p class="card-subtitle" id="repSub">Klik Tampilkan untuk melihat data</p></div>' +
        '</div>' +
        '<div class="card-body tight" id="repBody">' + App.loading('Pilih jenis laporan lalu klik Tampilkan.') + '</div>' +
      '</div>';

    fillDepartments();
    bind();
    updateVisibility();
  };

  function fillDepartments() {
    var meta_ = App.state.meta || { departments: [] };
    var sel = document.getElementById('rpDept');
    if (!sel) return;
    sel.innerHTML = '<option value="">Semua Unit Kerja</option>' +
      (meta_.departments || []).map(function (d) {
        return '<option value="' + d.id + '"' + (String(state.department_id) === String(d.id) ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('');
  }

  function bind() {
    document.getElementById('rpFormat').addEventListener('change', function () {
      state.format = this.value;
      updateVisibility();
    });
    document.getElementById('rpPreview').addEventListener('click', loadPreview);
    document.getElementById('repExcel').addEventListener('click', function () { download('excel'); });
    document.getElementById('repCsv').addEventListener('click', function () { download('csv'); });
    document.getElementById('repPrint').addEventListener('click', function () { window.print(); });
  }

  function updateVisibility() {
    var monthly = state.format === 'rekap_bulanan';
    var usesMonth = monthly || state.format === 'per_karyawan';

    document.getElementById('wrapMonth').style.display = usesMonth ? '' : 'none';
    document.getElementById('wrapFrom').style.display = usesMonth ? 'none' : '';
    document.getElementById('wrapTo').style.display = usesMonth ? 'none' : '';
  }

  function readFilters() {
    var fmt = document.getElementById('rpFormat').value;
    var usesMonth = fmt === 'rekap_bulanan' || fmt === 'per_karyawan';

    return {
      format: fmt,
      from: document.getElementById('rpFrom').value || App.startOfMonth(),
      to: document.getElementById('rpTo').value || App.today(),
      month: document.getElementById('rpMonth').value || App.today().slice(0, 7),
      department_id: document.getElementById('rpDept').value || '',
      status: document.getElementById('rpStatus').value || '',
      _usesMonth: usesMonth,
    };
  }

  function query(f) {
    var q = { format: f.format };
    if (f._usesMonth) q.month = f.month;
    else { q.from = f.from; q.to = f.to; }
    if (f.department_id) q.department_id = f.department_id;
    if (f.status) q.status = f.status;
    return q;
  }

  function loadPreview() {
    var f = readFilters();
    state.format = f.format;

    var box = document.getElementById('repBody');
    box.innerHTML = App.loading('Menyusun laporan...');

    api.get('/reports/preview', query(f))
      .then(function (res) {
        var report = res.data || {};
        var meta_ = report.meta || {};

        document.getElementById('repTitle').textContent = (FORMATS.find(function (x) { return x.key === f.format; }) || {}).label || 'Laporan';
        document.getElementById('repSub').textContent =
          (f._usesMonth ? 'Periode: ' + App.monthLabel(f.month) : 'Periode: ' + App.fmtDate(f.from) + ' s.d. ' + App.fmtDate(f.to)) +
          ' | ' + App.formatNumber(meta_.total || (report.rows || []).length) + ' baris' +
          ((report.rows || []).length > 500 ? ' (menampilkan 500 pertama)' : '');

        paintRows(f.format, report.rows || [], meta_);
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paintRows(format, rows, meta_) {
    var box = document.getElementById('repBody');
    if (rows.length === 0) {
      box.innerHTML = '<div class="empty-state"><div class="big">&#128202;</div>' +
        '<div>Tidak ada data pada periode dan filter tersebut.</div></div>';
      return;
    }

    var columns;
    if (format === 'rekap_harian') {
      columns = [
        { key: 'work_date', label: 'Tanggal', render: function (r) { return esc(App.fmtDate(r.work_date)); } },
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
        { key: 'shift_code', label: 'Shift', render: function (r) { return esc(r.shift_code || '-'); } },
        { key: 'first_in', label: 'Masuk', render: function (r) { return App.fmtTime(r.first_in); } },
        { key: 'first_out', label: 'Pulang', render: function (r) { return App.fmtTime(r.first_out); } },
        { key: 'late_minutes', label: 'Telat', align: 'right', render: function (r) { return (Number(r.late_minutes) || 0) > 0 ? r.late_minutes + "'" : '-'; } },
        { key: 'work_minutes', label: 'Durasi', align: 'right', render: function (r) { return App.fmtMinutes(r.work_minutes); } },
        { key: 'overtime_minutes', label: 'Lembur', align: 'right', render: function (r) { return (Number(r.overtime_minutes) || 0) > 0 ? App.fmtMinutes(r.overtime_minutes) : '-'; } },
        { key: 'status', label: 'Status', render: function (r) { return App.badge(r.status); } },
      ];
    } else if (format === 'rekap_bulanan') {
      columns = [
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
        { key: 'hadir', label: 'Hadir', align: 'right' },
        { key: 'telat', label: 'Telat', align: 'right' },
        { key: 'izin', label: 'Izin', align: 'right' },
        { key: 'sakit', label: 'Sakit', align: 'right' },
        { key: 'cuti', label: 'Cuti', align: 'right' },
        { key: 'alpa', label: 'Alpa', align: 'right' },
        { key: 'total_late_minutes', label: 'Total Telat', align: 'right', render: function (r) { return App.fmtMinutes(r.total_late_minutes); } },
        { key: 'total_work_minutes', label: 'Total Kerja', align: 'right', render: function (r) { return App.fmtMinutes(r.total_work_minutes); } },
        { key: 'total_overtime_minutes', label: 'Total Lembur', align: 'right', render: function (r) { return App.fmtMinutes(r.total_overtime_minutes); } },
      ];
    } else if (format === 'per_karyawan') {
      columns = [
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
        { key: 'position_name', label: 'Jabatan' },
        { key: 'days_present', label: 'Hari Hadir', align: 'right' },
        { key: 'total_late_minutes', label: 'Total Telat', align: 'right', render: function (r) { return App.fmtMinutes(r.total_late_minutes); } },
        { key: 'total_overtime_minutes', label: 'Total Lembur', align: 'right', render: function (r) { return App.fmtMinutes(r.total_overtime_minutes); } },
        { key: 'attendance_rate', label: 'Tingkat Kehadiran', align: 'right', render: function (r) {
          return (Number(r.attendance_rate) || 0).toFixed(1) + '%';
        } },
      ];
    } else if (format === 'log_mentah') {
      columns = [
        { key: 'log_time', label: 'Waktu', render: function (r) { return esc(App.fmtDateTime(r.log_time)); } },
        { key: 'employee_name', label: 'Karyawan', render: function (r) { return esc(r.employee_name || ('Tidak dikenal (' + (r.device_user_id || '-') + ')')); } },
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'device_name', label: 'Mesin' },
        { key: 'log_state_label', label: 'Jenis', render: function (r) { return esc(r.log_state_label || '-'); } },
        { key: 'verify_mode_label', label: 'Verifikasi', render: function (r) { return esc(r.verify_mode_label || '-'); } },
        { key: 'source', label: 'Sumber' },
        { key: 'work_code', label: 'Kode Kerja', mono: true },
      ];
    } else {
      columns = [
        { key: 'work_date', label: 'Tanggal', render: function (r) { return esc(App.fmtDateFull(r.work_date)); } },
        { key: 'hadir', label: 'Hadir', align: 'right', render: function (r) { return App.formatNumber(r.hadir); } },
        { key: 'telat', label: 'Telat', align: 'right', render: function (r) { return App.formatNumber(r.telat); } },
        { key: 'izin', label: 'Izin', align: 'right', render: function (r) { return App.formatNumber(r.izin); } },
        { key: 'sakit', label: 'Sakit', align: 'right', render: function (r) { return App.formatNumber(r.sakit); } },
        { key: 'cuti', label: 'Cuti', align: 'right', render: function (r) { return App.formatNumber(r.cuti); } },
        { key: 'alpa', label: 'Alpa', align: 'right', render: function (r) { return App.formatNumber(r.alpa); } },
        { key: 'total', label: 'Total', align: 'right', render: function (r) { return App.formatNumber(r.total); } },
      ];
    }

    var summaryBar = '';
    if (meta_.summary && Object.keys(meta_.summary).length > 0) {
      summaryBar = '<div class="card-body" style="border-bottom:1px solid var(--border)">' +
        '<div class="row">' + Object.keys(meta_.summary).map(function (k) {
          return '<span class="badge ' + (k === 'total' ? 'info' : (App.STATUS_LABELS[k] || 'info')) + '">' +
            esc(App.STATUS_LABELS[k] || k) + ': ' + App.formatNumber(meta_.summary[k]) + '</span>';
        }).join('') + '</div></div>';
    }

    box.innerHTML = summaryBar + App.table(columns, rows, { empty: 'Tidak ada data.' });

    // Simpan untuk cetak
    window.__reportRows = rows;
  }

  function download(kind) {
    var f = readFilters();
    var path = kind === 'excel' ? '/reports/export/excel' : '/reports/export/csv';

    api.download(path, query(f))
      .then(function (res) {
        var url = URL.createObjectURL(res.blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = res.filename || ('laporan-absensi.' + (kind === 'excel' ? 'xlsx' : 'csv'));
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        App.toast('Berkas ' + (kind === 'excel' ? 'Excel' : 'CSV') + ' diunduh.', 'success');
      })
      .catch(function (err) {
        App.toast('Gagal mengunduh: ' + err.message, 'error');
      });
  }
})();
