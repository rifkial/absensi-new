/* =============================================================================
 * Halaman HARI LIBUR
 * Daftar libur nasional / cuti bersama (hasil sinkronisasi dari API) plus
 * libur tambahan yang ditambahkan admin sendiri.
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  /* 1..7 = Senin..Minggu, sama dengan shifts.work_days. */
  var DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

  var KIND_LABEL = {
    nasional: 'Libur Nasional',
    cuti_bersama: 'Cuti Bersama',
    custom: 'Libur Tambahan',
  };

  var KIND_OPTIONS = [
    { value: 'custom', label: 'Libur Tambahan (perusahaan)' },
    { value: 'nasional', label: 'Libur Nasional' },
    { value: 'cuti_bersama', label: 'Cuti Bersama' },
  ];

  var rows = [];
  var filterYear = new Date().getFullYear();
  var filterSource = '';

  window.Pages.holidays = function (root) {
    var years = [];
    var now = new Date().getFullYear();
    for (var y = now - 1; y <= now + 3; y += 1) years.push(y);

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            '<button class="btn primary" id="hlSync">&#8635; Sinkronkan dari API</button>' +
            (App.can('holidays:write') ? '<button class="btn" id="hlAdd">+ Tambah Hari Libur</button>' : '') +
          '</div>' +
          '<div class="btn-group">' +
            '<select id="hlYear">' +
              years.map(function (y) {
                return '<option value="' + y + '"' + (y === filterYear ? ' selected' : '') + '>' + y + '</option>';
              }).join('') +
            '</select>' +
            '<select id="hlSource">' +
              '<option value="">Semua sumber</option>' +
              '<option value="sync">Sinkronisasi API</option>' +
              '<option value="manual">Manual</option>' +
            '</select>' +
            '<button class="btn" id="hlReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="hlSyncInfo"></div>' +
      '<div id="hlBody"></div>' +
      '<div class="callout mt"><strong>Bagaimana hari libur dipakai?</strong> ' +
        'Tanggal di daftar ini otomatis berstatus <strong>Hari Libur</strong> saat rekap absensi, sehingga tidak dihitung alpa. ' +
        'Bila perusahaan tetap buka pada tanggal tersebut, centang <strong>Tetap Bekerja</strong>. ' +
        'Jadwal per tanggal pada menu Shift &amp; Jadwal tetap didahulukan, jadi admin bisa memaksa sebagian karyawan tetap kerja di hari libur nasional.</div>';

    document.getElementById('hlReload').addEventListener('click', load);
    document.getElementById('hlSync').addEventListener('click', doSync);

    var add = document.getElementById('hlAdd');
    if (add) add.addEventListener('click', function () { openForm(null); });

    var yearSel = document.getElementById('hlYear');
    yearSel.value = String(filterYear);
    yearSel.addEventListener('change', function () {
      filterYear = Number(yearSel.value);
      load();
    });

    var srcSel = document.getElementById('hlSource');
    srcSel.value = filterSource;
    srcSel.addEventListener('change', function () {
      filterSource = srcSel.value;
      load();
    });

    load();
    loadSyncInfo();
  }

  function loadSyncInfo() {
    var box = document.getElementById('hlSyncInfo');
    if (!box) return;

    api.get('/holidays/sync-status')
      .then(function (res) {
        var s = res.data || {};
        var last = s.last_sync_at
          ? esc(App.fmtDate(s.last_sync_at))
          : '<span class="faint">belum pernah</span>';

        box.innerHTML = '<div class="callout mt"><strong>Sinkronisasi otomatis: ' +
          (s.enabled ? '<span class="badge success">Aktif</span>' : '<span class="badge idle">Nonaktif</span>') +
          '</strong>Setiap ' + s.interval_days + ' hari, untuk tahun ini sampai ' +
          s.years_ahead + ' tahun ke depan. Sinkron terakhir: ' + last +
          '. Nyalakan lewat <strong>Pengaturan &gt; Absensi &gt; Hari Libur</strong>. ' +
          'Sumber data: ' + (s.sources || []).map(function (x) { return esc(x.label); }).join(', ') +
          ' (gratis, tanpa API key).</div>';
      })
      .catch(function () { box.innerHTML = ''; });
  }

  function load() {
    var box = document.getElementById('hlBody');
    box.innerHTML = App.loading('Memuat hari libur...');

    api.get('/holidays?year=' + filterYear)
      .then(function (res) {
        rows = res.data || [];
        if (filterSource) {
          rows = rows.filter(function (r) { return r.source === filterSource; });
        }
        paint();
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paint() {
    var box = document.getElementById('hlBody');

    var counts = rows.reduce(function (acc, r) {
      acc[r.kind] = (acc[r.kind] || 0) + 1;
      return acc;
    }, {});

    var summary =
      '<div class="grid-2">' +
        '<div class="card"><div class="card-body tight">' +
          '<div class="row" style="justify-content:space-between;align-items:center">' +
            '<div><strong>' + rows.length + '</strong> hari libur tahun ' + filterYear + '</div>' +
            '<div class="small faint">' +
              Object.keys(KIND_LABEL).map(function (k) {
                return (counts[k] || 0) + ' ' + KIND_LABEL[k];
              }).join(' &middot; ') +
            '</div>' +
          '</div>' +
        '</div></div>' +
      '</div>';

    var columns = [
      { key: 'holiday_date', label: 'Tanggal', render: function (r) {
        var d = String(r.holiday_date).slice(0, 10);
        return '<div class="nowrap"><strong>' + esc(App.fmtDate(d)) + '</strong></div>' +
          '<div class="small faint">' + esc(dayName(d)) + '</div>';
      } },
      { key: 'name', label: 'Nama Hari Libur' },
      { key: 'kind', label: 'Jenis', render: function (r) {
        return '<span class="badge ' + kindBadge(r.kind) + '">' + esc(KIND_LABEL[r.kind] || r.kind) + '</span>';
      } },
      { key: 'source', label: 'Sumber', render: function (r) {
        return r.source === 'sync'
          ? '<span class="badge idle">API</span>'
          : '<span class="badge info">Manual</span>';
      } },
      { key: 'is_workday', label: 'Tetap Bekerja', render: function (r) {
        return Number(r.is_workday) === 1
          ? '<span class="badge warning">Ya</span>'
          : '<span class="faint">-</span>';
      } },
      { key: 'aksi', label: 'Aksi', width: '150px', render: function (r) {
        if (!App.can('holidays:write')) return '';
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' +
          '<button class="btn sm danger" data-act="delete" data-id="' + r.id + '">Hapus</button>' +
        '</div>';
      } },
    ];

    box.innerHTML = summary +
      '<div class="card"><div class="card-body tight">' + App.table(columns, rows, {
        empty: 'Belum ada hari libur untuk tahun ' + filterYear + '. Klik "Sinkronkan dari API" atau tambah manual.',
        emptyIcon: '&#127796;',
      }) + '</div></div>';

    box.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var row = rows.find(function (r) { return r.id === id; });
        if (b.getAttribute('data-act') === 'edit') openForm(row);
        else doDelete(row);
      });
    });
  }

  function kindBadge(kind) {
    if (kind === 'nasional') return 'success';
    if (kind === 'cuti_bersama') return 'warning';
    return 'info';
  }

  function dayName(isoDate) {
    var parts = String(isoDate).slice(0, 10).split('-');
    if (parts.length !== 3) return '';
    // 1970-01-01 = Kamis, index ISO 4.
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var jsDay = d.getDay();
    var iso = jsDay === 0 ? 7 : jsDay;
    return DAY_NAMES[iso - 1] || '';
  }

  // ---------------------------------------------------------------- Form

  function openForm(holiday) {
    var isEdit = Boolean(holiday);

    App.modal({
      title: isEdit ? 'Ubah Hari Libur' : 'Tambah Hari Libur',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field"><label>Tanggal <span class="req">*</span></label>' +
            '<input type="date" id="hfDate" value="' + esc(isEdit ? String(holiday.holiday_date).slice(0, 10) : App.today()) + '"></div>' +
          '<div class="field"><label>Jenis <span class="req">*</span></label><select id="hfKind">' +
            KIND_OPTIONS.map(function (o) {
              var sel = (isEdit ? holiday.kind : 'custom') === o.value ? ' selected' : '';
              return '<option value="' + o.value + '"' + sel + '>' + esc(o.label) + '</option>';
            }).join('') +
          '</select></div>' +
          '<div class="field full"><label>Nama Hari Libur <span class="req">*</span></label>' +
            '<input type="text" id="hfName" maxlength="150" value="' +
              esc(isEdit ? holiday.name : '') + '" placeholder="mis. Hari Raya Natal"></div>' +
          '<div class="field full"><label>Keterangan</label>' +
            '<input type="text" id="hfNote" maxlength="255" value="' +
              esc(isEdit && holiday.note ? holiday.note : '') + '"></div>' +
          '<div class="field checkbox full"><input type="checkbox" id="hfWorkday"' +
            (isEdit && Number(holiday.is_workday) === 1 ? ' checked' : '') + '>' +
            '<label for="hfWorkday">Tetap bekerja pada tanggal ini (jangan dihitung hari libur)</label></div>' +
        '</div>' +
        (isEdit && holiday.source === 'sync'
          ? '<div class="callout mt">Baris ini hasil sinkronisasi dari API. prochain sinkron akan memperbarui nama dan jenisnya, ' +
            'tetapi perubahan manual tidak akan ditimpa selama baris ini tetap di sini.</div>'
          : ''),

      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Simpan',
          className: 'primary',
          onClick: function (el) {
            var date = el.querySelector('#hfDate').value;
            var name = el.querySelector('#hfName').value.trim();
            var kind = el.querySelector('#hfKind').value;

            if (!date) { App.toast('Tanggal wajib diisi.', 'error'); return false; }
            if (!name) { App.toast('Nama hari libur wajib diisi.', 'error'); return false; }

            var payload = {
              holiday_date: date,
              name: name,
              kind: kind,
              is_workday: el.querySelector('#hfWorkday').checked ? 1 : 0,
              note: el.querySelector('#hfNote').value.trim() || null,
            };

            var request = isEdit ? api.put('/holidays/' + holiday.id, payload) : api.post('/holidays', payload);
            request
              .then(function () {
                App.toast(isEdit ? 'Hari libur diperbarui.' : 'Hari libur ditambahkan.', 'success');
                el.closeModal();
                load();
              })
              .catch(function (err) { App.toast(err.message, 'error'); return false; });
            return false;
          },
        },
      ],
    });
  }

  function doDelete(holiday) {
    App.confirm({
      title: 'Hapus hari libur',
      heading: 'Hapus ' + holiday.name + '?',
      message: 'Rekap absensi perlu dihitung ulang agar tanggal ' +
        String(holiday.holiday_date).slice(0, 10) + ' tidak lagi berstatus Hari Libur.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/holidays/' + holiday.id)
          .then(function () {
            App.toast('Hari libur dihapus.', 'success');
            load();
            api.post('/attendance/generate', {
              from: String(holiday.holiday_date).slice(0, 10),
              to: String(holiday.holiday_date).slice(0, 10),
            }).catch(function () {});
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  // ---------------------------------------------------------------- Sinkronisasi

  function doSync() {
    var now = new Date().getFullYear();

    App.modal({
      title: 'Sinkronkan Hari Libur Nasional',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field"><label>Dari Tahun <span class="req">*</span></label>' +
            '<input type="number" id="hlFrom" value="' + now + '" min="2000" max="2100"></div>' +
          '<div class="field"><label>Sampai Tahun</label>' +
            '<input type="number" id="hlTo" value="' + (now + 1) + '" min="2000" max="2100"></div>' +
        '</div>' +
        '<div class="callout mt"><strong>Cara kerja</strong> Data diambil dari API hari libur nasional Indonesia (gratis, tanpa API key), ' +
          'lalu disimpan ke database sehingga rekap tetap bisa dihitung walau internet mati. ' +
          'Baris yang sudah kamu ubah manual <strong>tidak akan ditimpa</strong>.</div>' +
        '<div class="field checkbox mt"><input type="checkbox" id="hlRecalc" checked>' +
          '<label for="hlRecalc">Hitung ulang rekap absensi untuk tahun tersebut</label></div>',

      actions: [
        { label: 'Batal' },
        {
          label: 'Sinkronkan',
          className: 'primary',
          onClick: function (el) {
            var from = Number(el.querySelector('#hlFrom').value);
            var to = Number(el.querySelector('#hlTo').value) || from;

            if (!from) { App.toast('Tahun wajib diisi.', 'error'); return false; }
            if (to < from) { App.toast('Tahun akhir harus >= tahun awal.', 'error'); return false; }

            var recalc = el.querySelector('#hlRecalc').checked;
            el.closeModal();

            App.toast('Mengambil data hari libur...', 'info');
            api.post('/holidays/sync', { year: from, to_year: to, recalculate: recalc })
              .then(function (res) {
                App.toast(res.message || 'Sinkronisasi selesai.', 'success');
                if (filterYear >= from && filterYear <= to) {
                  filterYear = from;
                  window.Pages.holidays(document.getElementById('pageContent'));
                } else {
                  load();
                }
              })
              .catch(function (err) { App.toast(err.message, 'error'); });

            return false;
          },
        },
      ],
    });
  }
})();
