/* =============================================================================
 * Halaman LAPORAN
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

  var state = {
    format: 'rekap_kehadiran',
    // Default bulan berjalan (1 s/d hari ini) supaya dinas hari ini langsung masuk.
    from: App.startOfMonth(),
    to: App.today(),
    month: App.today().slice(0, 7),
    department_id: '',
    employee_id: '',
    status: '',
    page: 1,
    per_page: 50,
  };

  /**
   * Daftar format laporan.
   *
   * Daftar idealnya datang dari GET /api/reports/formats supaya server dan UI
   * tidak pernah berbeda. Daftar di bawah hanya dipakai sebagai cadangan bila
   * permintaan itu gagal, agar halaman tetap bisa dipakai.
   */
  var FALLBACK_FORMATS = [
    { key: 'rekap_harian', label: 'Rekap Harian (per karyawan per tanggal)', scope: 'range' },
    { key: 'rekap_bulanan', label: 'Rekap Bulanan (per karyawan)', scope: 'month' },
    { key: 'per_karyawan', label: 'Rekap per Karyawan (ringkas)', scope: 'month' },
    { key: 'lembur', label: 'Lembur per Karyawan', scope: 'range' },
    { key: 'rekap_kehadiran', label: 'Rekap Kehadiran per Karyawan', scope: 'range' },
    { key: 'ringkasan', label: 'Ringkasan per Hari', scope: 'range' },
    { key: 'log_mentah', label: 'Log Absensi Mentah (seluruh scan)', scope: 'range' },
  ];

  var FORMATS = FALLBACK_FORMATS;

  /** Ganti dropdown format dengan daftar dari server. */
  function applyFormats(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    FORMATS = list.filter(function (f) { return f && f.key && f.label; });

    var sel = document.getElementById('rpFormat');
    if (!sel) return;

    sel.innerHTML = FORMATS.map(function (f) {
      return '<option value="' + escAttr(f.key) + '"' + (state.format === f.key ? ' selected' : '') + '>' +
        esc(f.label) + '</option>';
    }).join('');

    // Format bawaan harus benar-benar ada di daftar server.
    if (!FORMATS.some(function (f) { return f.key === state.format; }) && FORMATS.length > 0) {
      state.format = FORMATS[0].key;
      sel.value = state.format;
    }

    updateVisibility();
  }

  function loadFormats() {
    api.get('/reports/formats')
      .then(function (res) { applyFormats((res.data || {}).formats); })
      .catch(function () { /* tetap pakai FALLBACK_FORMATS */ });
  }

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
            '<div class="field"><label for="rpFormat">Jenis Laporan <span class="req">*</span></label><select id="rpFormat">' +
              FORMATS.map(function (f) {
                return '<option value="' + f.key + '"' + (state.format === f.key ? ' selected' : '') + '>' + esc(f.label) + '</option>';
              }).join('') +
            '</select></div>' +
            '<div class="field" id="wrapFrom"><label for="rpFrom">Dari Tanggal</label><input type="date" id="rpFrom" value="' + esc(state.from) + '"></div>' +
            '<div class="field" id="wrapTo"><label for="rpTo">Sampai Tanggal</label><input type="date" id="rpTo" value="' + esc(state.to) + '"></div>' +
            '<div class="field" id="wrapMonth"><label for="rpMonth">Bulan</label><input type="month" id="rpMonth" value="' + esc(state.month) + '"></div>' +
            '<div class="field"><label for="rpDept">Unit Kerja</label><select id="rpDept"><option value="">Semua</option></select></div>' +
            '<div class="field" id="wrapStatus"><label for="rpStatus">Status</label><select id="rpStatus"><option value="">Semua</option>' +
['hadir', 'telat', 'dinas_luar', 'dinas_dalam', 'izin', 'sakit', 'cuti', 'alpa', 'belum', 'hari_libur'].map(function (s) {
    return '<option value="' + s + '">' + esc(App.STATUS_LABELS[s] || s) + '</option>';
              }).join('') +
            '</select><span class="help" id="statusHelp">Hanya untuk Rekap Harian.</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title" id="repTitle">Hasil Laporan</h2>' +
          '<p class="card-subtitle" id="repSub">Klik Tampilkan untuk melihat data</p></div>' +
        '</div>' +
        '<div class="card-body tight" id="repBody">' + App.loading('Menyusun laporan...') + '</div>' +
      '</div>';

    fillDepartments();
    bind();
    updateVisibility();

    // Daftar format diambil dari server supaya UI tidak pernah berbeda dengan
    // format yang benar-benar didukung. Bawaan sudah terisi, jadi halaman
    // tetap bisa dipakai walau permintaan ini gagal.
    loadFormats();

    // Muat otomatis supaya halaman tidak terlihat kosong saat pertama dibuka.
    loadPreview();
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
    var fmt = document.getElementById('rpFormat');
    var preview = document.getElementById('repPreview');
    var excel = document.getElementById('repExcel');
    var csv = document.getElementById('repCsv');
    var print = document.getElementById('repPrint');

    if (fmt) fmt.addEventListener('change', function () {
      state.format = this.value;
      updateVisibility();
      loadPreview();
    });
    if (preview) preview.addEventListener('click', loadPreview);
    if (excel) excel.addEventListener('click', function () { download('excel'); });
    if (csv) csv.addEventListener('click', function () { download('csv'); });
    if (print) print.addEventListener('click', printReport);

    // Filter lain ikut refresh pratinjau saat diganti.
    ['rpDept', 'rpStatus', 'rpFrom', 'rpTo', 'rpMonth'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', loadPreview);
    });
  }

  /** Format bulan memakai filter "Bulan", selain itu memakai rentang tanggal. */
  function isMonthlyFormat(key) {
    var found = FORMATS.find(function (f) { return f.key === key; });
    return found ? found.scope === 'month' : (key === 'rekap_bulanan' || key === 'per_karyawan');
  }

  function updateVisibility() {
    var usesMonth = isMonthlyFormat(state.format);

    document.getElementById('wrapMonth').style.display = usesMonth ? '' : 'none';
    document.getElementById('wrapFrom').style.display = usesMonth ? 'none' : '';
    document.getElementById('wrapTo').style.display = usesMonth ? 'none' : '';

    var statusWrap = document.getElementById('wrapStatus');
    if (statusWrap) {
      var show = STATUS_FORMATS.indexOf(state.format) >= 0;
      statusWrap.style.display = show ? '' : 'none';
      if (!show) {
        var sel = document.getElementById('rpStatus');
        if (sel) sel.value = '';
      }
    }
  }

  function readFilters() {
    var fmt = document.getElementById('rpFormat').value;
    var usesMonth = isMonthlyFormat(fmt);

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

  // Filter status hanya dipakai Rekap Harian (baris = 1 karyawan 1 tanggal).
  // Format agregat (bulanan/kehadiran/dll) selalu tampil penuh.
  var STATUS_FORMATS = ['rekap_harian'];

  function query(f) {
    var q = { format: f.format, page: state.page, per_page: state.per_page };
    if (f._usesMonth) q.month = f.month;
    else { q.from = f.from; q.to = f.to; }
    if (f.department_id) q.department_id = f.department_id;
    if (f.status && STATUS_FORMATS.indexOf(f.format) >= 0) q.status = f.status;
    return q;
  }

  function loadPreview(resetPage) {
    var f = readFilters();
    state.format = f.format;
    if (resetPage !== false) state.page = 1;

    var box = document.getElementById('repBody');
    box.innerHTML = App.loading('Menyusun laporan...');

    api.get('/reports/preview', query(f))
      .then(function (res) {
        var report = res.data || {};
        var meta_ = report.meta || {};
        state.page = meta_.page || 1;

        document.getElementById('repTitle').textContent = (FORMATS.find(function (x) { return x.key === f.format; }) || {}).label || 'Laporan';
        document.getElementById('repSub').textContent =
          (f._usesMonth ? 'Periode: ' + App.monthLabel(f.month) : 'Periode: ' + App.fmtDate(f.from) + ' s.d. ' + App.fmtDate(f.to)) +
          ' | ' + App.formatNumber(meta_.total || (report.rows || []).length) + ' baris';

        try {
          paintRows(f.format, report.rows || [], meta_);
        } catch (e) {
          box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div>' +
            '<div>Error render: ' + esc(e.message) + '</div></div>';
        }
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
    if (format === 'rekap_kehadiran') {
      var baseNo = ((meta_.page || 1) - 1) * (meta_.per_page || rows.length);
      columns = [
        { key: 'no_urut', label: 'No', align: 'right', render: function (r, i) { return baseNo + i + 1; } },
        { key: 'employee_code', label: 'ID Karyawan', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Divisi/Departemen' },
        { key: 'position_name', label: 'Jabatan' },
        { key: 'total_hari_kerja', label: 'Total Hari Kerja', align: 'right' },
        { key: 'total_hadir', label: 'Total Kehadiran', align: 'right' },
        { key: 'total_izin', label: 'Total Izin', align: 'right' },
        { key: 'total_cuti', label: 'Total Cuti', align: 'right' },
        { key: 'total_dinas_luar', label: 'Total Dinas Luar', align: 'right' },
        { key: 'total_dinas_dalam', label: 'Total Dinas Dalam', align: 'right' },
        { key: 'total_hari_terlambat', label: 'Total Hari Terlambat', align: 'right' },
        { key: 'total_lembur_jam', label: 'Total Lemburan (jam)', align: 'right' },
      ];
    } else if (format === 'rekap_harian') {
      columns = [
        { key: 'work_date', label: 'Tanggal', render: function (r) { return esc(App.fmtDate(r.work_date)); } },
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
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
        { key: 'total_days', label: 'Total Hari', align: 'right' },
        { key: 'total_hadir', label: 'Hadir', align: 'right' },
        { key: 'total_telat', label: 'Telat', align: 'right' },
        { key: 'total_izin', label: 'Izin', align: 'right' },
        { key: 'total_sakit', label: 'Sakit', align: 'right' },
        { key: 'total_cuti', label: 'Cuti', align: 'right' },
        { key: 'total_dinas_luar', label: 'Dinas Luar', align: 'right' },
        { key: 'total_dinas_dalam', label: 'Dinas Dalam', align: 'right' },
        { key: 'total_alpa', label: 'Alpa', align: 'right' },
        { key: 'persen_hadir', label: '% Kehadiran', align: 'right', render: function (r) { return App.formatNumber(r.persen_hadir) + '%'; } },
        { key: 'total_late_minutes', label: 'Total Telat', align: 'right', render: function (r) { return App.fmtMinutes(r.total_late_minutes); } },
        { key: 'total_kerja_jam', label: 'Total Kerja (jam)', align: 'right' },
        { key: 'total_lembur_jam', label: 'Total Lembur (jam)', align: 'right' },
      ];
    } else if (format === 'per_karyawan') {
      columns = [
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
        { key: 'hari_kerja', label: 'Hari Kerja', align: 'right' },
        { key: 'hadir', label: 'Hadir', align: 'right' },
        { key: 'telat', label: 'Telat', align: 'right' },
        { key: 'izin', label: 'Izin', align: 'right' },
        { key: 'sakit', label: 'Sakit', align: 'right' },
        { key: 'dinas_luar', label: 'Dinas Luar', align: 'right' },
        { key: 'dinas_dalam', label: 'Dinas Dalam', align: 'right' },
        { key: 'alpa', label: 'Alpa', align: 'right' },
        { key: 'persen_hadir', label: '% Kehadiran', align: 'right', render: function (r) {
          return App.formatNumber(r.persen_hadir) + '%';
        } },
        { key: 'total_late_minutes', label: 'Total Telat', align: 'right', render: function (r) { return App.fmtMinutes(r.total_late_minutes); } },
        { key: 'total_work_minutes', label: 'Total Kerja', align: 'right', render: function (r) { return App.fmtMinutes(r.total_work_minutes); } },
      ];
    } else if (format === 'lembur') {
      columns = [
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'employee_name', label: 'Nama' },
        { key: 'department_name', label: 'Unit Kerja' },
        { key: 'position_name', label: 'Jabatan' },
        { key: 'days_with_overtime', label: 'Hari Lembur', align: 'right' },
        { key: 'total_overtime_minutes', label: 'Total Lembur', align: 'right', render: function (r) { return App.fmtMinutes(r.total_overtime_minutes); } },
        { key: 'total_overtime_jam', label: 'Total (jam)', align: 'right' },
        { key: 'max_overtime_minutes', label: 'Terlama', align: 'right', render: function (r) { return App.fmtMinutes(r.max_overtime_minutes); } },
      ];
    } else if (format === 'log_mentah') {
      columns = [
        { key: 'log_time', label: 'Waktu', render: function (r) { return esc(App.fmtDateTime(r.log_time)); } },
        { key: 'employee_name', label: 'Karyawan', render: function (r) { return esc(r.employee_name || ('Tidak dikenal (' + (r.device_user_id || '-') + ')')); } },
        { key: 'employee_code', label: 'Kode', mono: true },
        { key: 'device_name', label: 'Mesin' },
        { key: 'state_label', label: 'Jenis', render: function (r) { return esc(r.state_label || '-'); } },
        { key: 'metode', label: 'Verifikasi', render: function (r) { return esc(r.metode || '-'); } },
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
        { key: 'dinas_luar', label: 'Dinas Luar', align: 'right', render: function (r) { return App.formatNumber(r.dinas_luar); } },
        { key: 'dinas_dalam', label: 'Dinas Dalam', align: 'right', render: function (r) { return App.formatNumber(r.dinas_dalam); } },
        { key: 'alpa', label: 'Alpa', align: 'right', render: function (r) { return App.formatNumber(r.alpa); } },
        { key: 'hari_libur', label: 'Libur', align: 'right', render: function (r) { return App.formatNumber(r.hari_libur); } },
        { key: 'total', label: 'Total', align: 'right', render: function (r) { return App.formatNumber(r.total); } },
      ];
    }

    // Ringkasan hanya ditampilkan bila berupa peta angka (mis. per_karyawan),
    // bukan objek bersarang seperti { totals, by_status, per_day }.
    var summaryKeys = meta_.summary && typeof meta_.summary === 'object'
      ? Object.keys(meta_.summary).filter(function (k) { return typeof meta_.summary[k] === 'number'; })
      : [];
    var summaryBar = '';
    if (summaryKeys.length > 0) {
      summaryBar = '<div class="card-body" style="border-bottom:1px solid var(--border)">' +
        '<div class="row">' + summaryKeys.map(function (k) {
          return '<span class="badge ' + (k === 'total' ? 'info' : (App.STATUS_LABELS[k] || 'info')) + '">' +
            esc(App.STATUS_LABELS[k] || k) + ': ' + App.formatNumber(meta_.summary[k]) + '</span>';
        }).join('') + '</div></div>';
    }

    var pager = '';
    if ((meta_.total_pages || 0) > 1) {
      pager = '<div class="pagination">' +
        '<span>' + App.formatNumber(meta_.total || 0) + ' baris | Halaman ' + (meta_.page || 1) +
          ' dari ' + (meta_.total_pages || 1) + '</span>' +
        '<button class="btn sm" data-pg="prev"' + ((meta_.page || 1) <= 1 ? ' disabled' : '') + '>&laquo; Sebelumnya</button>' +
        '<button class="btn sm" data-pg="next"' + ((meta_.page || 1) >= (meta_.total_pages || 1) ? ' disabled' : '') + '>Berikutnya &raquo;</button>' +
      '</div>';
    }

    box.innerHTML = summaryBar + App.table(columns, rows, { empty: 'Tidak ada data.' }) + pager;

    box.querySelectorAll('button[data-pg]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.page = b.getAttribute('data-pg') === 'next' ? (meta_.page || 1) + 1 : (meta_.page || 1) - 1;
        loadPreview(false);
      });
    });

    window.__reportRows = rows;
    window.__reportColumns = columns;
  }

  function printText(value) {
    var tmp = document.createElement('div');
    tmp.innerHTML = value == null ? '' : String(value);
    return tmp.textContent || tmp.innerText || '-';
  }

  function printReport() {
    var rows = window.__reportRows || [];
    var columns = window.__reportColumns || [];
    if (!rows.length || !columns.length) { App.toast('Tampilkan laporan dulu sebelum mencetak.', 'error'); return; }
    var f = readFilters();
    var label = (FORMATS.find(function (x) { return x.key === f.format; }) || {}).label || 'Laporan';
    var periode = f._usesMonth
      ? 'Periode: ' + App.monthLabel(f.month)
      : 'Periode: ' + App.fmtDate(f.from) + ' s.d. ' + App.fmtDate(f.to);
    var w = window.open('', '_blank', 'width=1000,height=800');
    if (!w) { App.toast('Popup diblokir browser. Izinkan popup untuk mencetak.', 'error'); return; }
    var head = columns.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('');
    var body = rows.map(function (r, i) {
      var tds = columns.map(function (c) {
        var raw = typeof c.render === 'function' ? c.render(r, i) : (r[c.key] == null ? '-' : r[c.key]);
        return '<td>' + esc(printText(raw)) + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    w.document.write(
      '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>' + esc(label) + '</title>' +
      '<style>body{font-family:Arial,sans-serif;margin:24px;color:#111;font-size:12px}' +
      'h2{margin:0;font-size:18px;text-align:center}h3{margin:4px 0 2px;font-size:14px;text-align:center}' +
      '.sub{text-align:center;color:#555;margin-bottom:12px}' +
      'table{width:100%;border-collapse:collapse}th,td{border:1px solid #999;padding:5px 7px;text-align:left}' +
      'th{background:#eee}.num{text-align:right}' +
      '@media print{.noprint{display:none}}</style></head><body>' +
      '<h2>' + esc(label) + '</h2>' +
      '<h3>Aplikasi Absensi Fingerprint</h3>' +
      '<div class="sub">' + esc(periode) + ' | Dicetak: ' + esc(new Date().toLocaleString('id-ID')) + '</div>' +
      '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' +
      '<div class="noprint" style="margin-top:16px;text-align:center">' +
      '<button onclick="window.print()">Cetak</button></div>' +
      '</body></html>'
    );
    w.document.close();
    w.focus();
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
