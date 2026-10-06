/* =============================================================================
 * Halaman SHIFT & JADWAL
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var shifts = [];
  var tab = 'shifts';

  /* 1..7 = Senin..Minggu, sama dengan kolom shifts.work_days dan
     services/settings.js (isoWeekday). */
  var WORK_DAY_NAMES = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

  window.Pages.shifts = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            '<button class="btn ' + (tab === 'shifts' ? 'primary' : '') + '" data-tab="shifts">Daftar Shift</button>' +
            '<button class="btn ' + (tab === 'bulk' ? 'primary' : '') + '" data-tab="bulk">Buat Jadwal Massal</button>' +
          '</div>' +
          '<div class="btn-group">' +
            (App.can('shifts:write') ? '<button class="btn primary" id="shiftAdd">+ Tambah Shift</button>' : '') +
            '<button class="btn" id="shiftReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="shiftBody"></div>';

    document.querySelectorAll('#pageContent [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        window.Pages.shifts(root);
      });
    });

    document.getElementById('shiftReload').addEventListener('click', load);
    var add = document.getElementById('shiftAdd');
    if (add) add.addEventListener('click', function () { openForm(null); });

    load();
  };

  function load() {
    var box = document.getElementById('shiftBody');
    box.innerHTML = App.loading('Memuat shift...');

    api.get('/shifts')
      .then(function (res) {
        shifts = res.data || [];
        if (tab === 'shifts') paintList(); else paintBulk();
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paintList() {
    var box = document.getElementById('shiftBody');

    var columns = [
      { key: 'code', label: 'Kode', mono: true },
      { key: 'name', label: 'Nama Shift' },
      { key: 'start_time', label: 'Mulai', render: function (r) { return esc(App.fmtTime(r.start_time)); } },
      { key: 'end_time', label: 'Selesai', render: function (r) { return esc(App.fmtTime(r.end_time)); } },
      { key: 'break_time', label: 'Istirahat', render: function (r) {
        return r.break_start ? esc(App.fmtTime(r.break_start)) + ' - ' + esc(App.fmtTime(r.break_end)) : '<span class="faint">-</span>';
      } },
      { key: 'duration', label: 'Durasi', align: 'right', render: function (r) { return App.fmtMinutes(r.duration_minutes); } },
      { key: 'late_tolerance_min', label: 'Toleransi Telat', align: 'right', render: function (r) {
        return r.late_tolerance_min + ' menit';
      } },
      { key: 'work_days', label: 'Hari Kerja', render: function (r) { return esc(workDaysLabel(r.work_days)); } },
      { key: 'is_active', label: 'Status', render: function (r) {
        return Number(r.is_active) === 1
          ? '<span class="badge success">Aktif</span>'
          : '<span class="badge idle">Nonaktif</span>';
      } },
      { key: 'aksi', label: 'Aksi', width: '150px', render: function (r) {
        if (!App.can('shifts:write')) return '';
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' +
          '<button class="btn sm danger" data-act="delete" data-id="' + r.id + '">Hapus</button>' +
        '</div>';
      } },
    ];

    box.innerHTML = '<div class="card"><div class="card-body tight">' + App.table(columns, shifts, {
      empty: 'Belum ada shift. Tambahkan shift minimal satu untuk dapat menghitung rekap.',
      emptyIcon: '&#9200;',
    }) + '</div></div>';

    box.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var act = b.getAttribute('data-act');
        var row = shifts.find(function (s) { return s.id === id; });
        if (act === 'edit') openForm(row);
        else if (act === 'delete') doDelete(row);
      });
    });
  }

  /**
   * Label hari kerja. Angka 7 (Minggu) sengaja dilewati karena hari Minggu
   * tidak pernah boleh menjadi hari kerja; data lama yang masih memuat 7
   * karena itu hanya menampilkan hari lainnya.
   */
  function workDaysLabel(value) {
    var days = String(value || '').split(',').map(function (d) { return Number(d.trim()); });
    var names = [];
    var invalid = [];
    for (var i = 0; i < days.length; i += 1) {
      if (days[i] >= 1 && days[i] <= 6) names.push(WORK_DAY_NAMES[days[i] - 1].slice(0, 3));
      else if (days[i] === 7) names.push(WORK_DAY_NAMES[6].slice(0, 3) + '*');
      else invalid.push(days[i]);
    }
    var label = names.length > 0 ? names.join(', ') : '-';
    if (invalid.length > 0) {
      return label + ' <span class="badge danger">data tidak valid: ' + invalid.join(',') + '</span>';
    }
    return label;
  }

  function paintBulk() {
    var meta_ = App.state.meta || { shifts: [], departments: [] };
    var box = document.getElementById('shiftBody');

    if (!App.can('attendance:write')) {
      box.innerHTML = '<div class="card"><div class="empty-state"><div class="big">&#128683;</div>' +
        '<div>Anda tidak punya hak akses membuat jadwal.</div></div></div>';
      return;
    }

    box.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Jadwal Satu Tanggal</h2>' +
          '<p class="card-subtitle">Terapkan shift yang sama ke semua karyawan pada tanggal tertentu.</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field"><label>Tanggal <span class="req">*</span></label><input type="date" id="bkDate" value="' + esc(App.today()) + '"></div>' +
              '<div class="field"><label>Shift</label><select id="bkShift"><option value="">- (kosong) -</option>' +
                (meta_.shifts || []).map(function (s) { return '<option value="' + s.id + '">' + esc(s.code + ' - ' + s.name) + '</option>'; }).join('') +
              '</select></div>' +
          '<div class="field"><label>Jenis Hari</label><select id="bkType">' +
              '<option value="kerja">Hari Kerja</option><option value="libur">Hari Libur</option><option value="cuti">Cuti</option></select>' +
              '<span class="help">Pilih "Hari Kerja" bila tanggal ini libur nasional tapi perusahaan tetap buka.</span></div>' +
              '<div class="field"><label>Unit Kerja</label><select id="bkDept"><option value="">Semua Unit Kerja</option>' +
                (meta_.departments || []).map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + '</option>'; }).join('') +
              '</select></div>' +
            '</div>' +
            '<button class="btn primary mt" id="bkRun">Buat Jadwal Tanggal Ini</button>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-header"><div><h2 class="card-title">Jadwal Berulang</h2>' +
          '<p class="card-subtitle">Buat jadwal periode panjang untuk semua karyawan.</p></div></div>' +
          '<div class="card-body">' +
            '<div class="form-grid">' +
              '<div class="field"><label>Dari <span class="req">*</span></label><input type="date" id="gsFrom" value="' + esc(App.today()) + '"></div>' +
              '<div class="field"><label>Sampai <span class="req">*</span></label><input type="date" id="gsTo" value="' + esc(App.addDays(App.today(), 29)) + '"></div>' +
              '<div class="field"><label>Unit Kerja</label><select id="gsDept"><option value="">Semua Unit Kerja</option>' +
                (meta_.departments || []).map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + '</option>'; }).join('') +
              '</select></div>' +
            '</div>' +
            '<div class="field"><label>Hari Kerja <span class="req">*</span></label>' +
              '<input type="hidden" id="gsDays" value="1,2,3,4,5">' +
              '<div class="row" id="gsDaysRow" style="gap:14px;flex-wrap:wrap">' +
                ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'].map(function (name, i) {
                  var day = i + 1;
                  return '<div class="field checkbox full" style="grid-column:auto">' +
                    '<input type="checkbox" class="gsDay" value="' + day + '" id="gsd' + day + '"' +
                    (day <= 5 ? ' checked' : '') + '><label for="gsd' + day + '">' + esc(name) + '</label></div>';
                }).join('') +
              '</div>' +
              '<span class="help">Jadwal global untuk seluruh karyawan pada rentang ini. ' +
                'Jam kerja tiap karyawan tetap mengikuti shift masing-masing. ' +
                'Hari Minggu selalu libur dan tidak bisa dipilih.</span>' +
            '</div>' +
            '<div class="callout mt">Tanggal yang tidak dicentang ditandai sebagai Hari Libur untuk semua karyawan. ' +
              'Maksimal 120 hari.</div>' +
            '<button class="btn primary mt" id="gsRun">Buat Jadwal Berulang</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('bkRun').addEventListener('click', function () {
      var btn = this;
      var payload = {
        date: document.getElementById('bkDate').value,
        shift_id: document.getElementById('bkShift').value || null,
        day_type: document.getElementById('bkType').value,
        department_id: document.getElementById('bkDept').value || null,
      };
      if (!payload.date) { App.toast('Tanggal wajib diisi.', 'error'); return; }

      App.confirm({
        title: 'Buat jadwal massal',
        heading: 'Terapkan jadwal ke semua karyawan?',
        message: 'Jadwal untuk tanggal ' + App.fmtDate(payload.date) + ' akan diganti pada seluruh karyawan yang terpilih.',
        confirmLabel: 'Buat Jadwal',
        onConfirm: function () {
          btn.disabled = true;
          api.post('/shifts/bulk-schedule', payload)
            .then(function (res) {
              App.toast(res.data.saved + ' jadwal karyawan disimpan.', 'success');
              return api.post('/attendance/generate', { from: payload.date, to: payload.date, department_id: payload.department_id });
            })
            .then(function () { App.toast('Rekap untuk tanggal tersebut dihitung ulang.', 'success'); })
            .catch(function (err) { App.toast(err.message, 'error'); });
        },
      });
    });

document.getElementById('gsRun').addEventListener('click', function () {
      var btn = this;
      var payload = {
        from: document.getElementById('gsFrom').value,
        to: document.getElementById('gsTo').value,
        department_id: document.getElementById('gsDept').value || null,
        work_days: syncGsDays(),
      };
      if (!payload.from || !payload.to) { App.toast('Tanggal wajib diisi.', 'error'); return; }
      if (!payload.work_days) { App.toast('Pilih minimal satu hari kerja.', 'error'); return; }

      var dayNames = WORK_DAY_NAMES;
      var picked = payload.work_days.split(',').map(function (d) {
        return dayNames[Number(d) - 1] || d;
      }).join(', ');

      App.confirm({
        title: 'Buat jadwal berulang',
        heading: 'Buat jadwal ' + App.fmtDate(payload.from) + ' s/d ' + App.fmtDate(payload.to) + '?',
        message: 'Jadwal pada rentang tersebut akan ditimpa. Hari kerja: ' + picked +
          '. Semua hari lain ditandai Hari Libur untuk setiap karyawan.',
        confirmLabel: 'Buat Jadwal',
        onConfirm: function () {
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> Proses...';
          api.post('/shifts/generate-schedule', payload)
            .then(function (res) {
              var d = res.data;
              App.toast(d.created + ' entri jadwal dibuat untuk ' + d.employees + ' karyawan (' + d.days + ' hari). ' + d.skipped + ' karyawan dilewati.', 'success');
              if (d.created > 0) {
                api.post('/attendance/generate', { from: payload.from, to: payload.to, department_id: payload.department_id })
                  .catch(function () {});
              }
            })
            .catch(function (err) { App.toast(err.message, 'error'); })
            .then(function () { btn.disabled = false; btn.textContent = 'Buat Jadwal Berulang'; });
        },
      });
    });
  }

  /** Kumpulkan checkbox hari kerja jadwal jadi "1,2,3,4,5". */
  function syncGsDays() {
    var hidden = document.getElementById('gsDays');
    if (!hidden) return '';

    var picked = Array.prototype.slice
      .call(document.querySelectorAll('.gsDay'))
      .filter(function (cb) { return cb.checked; })
      .map(function (cb) { return Number(cb.value); })
      .sort(function (a, b) { return a - b; });

    if (picked.length === 0) return '';

    hidden.value = picked.join(',');
    return hidden.value;
  }

  // ---------------------------------------------------------------- Form shift

  function openForm(shift) {
    var isEdit = Boolean(shift);
    var days = shift ? String(shift.work_days || '').split(',').map(Number) : [1, 2, 3, 4, 5];
    var checkedDays = {};
    days.forEach(function (d) { checkedDays[d] = true; });

    App.modal({
      title: isEdit ? 'Ubah Shift: ' + shift.name : 'Tambah Shift',
      size: 'wide',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field"><label>Kode <span class="req">*</span></label>' +
            '<input type="text" id="sfCode" value="' + esc(isEdit ? shift.code : '') + '" placeholder="PAGI" ' + (isEdit ? 'disabled' : '') + '>' +
            (isEdit ? '<span class="help">Kode shift tidak dapat diubah setelah dibuat.</span>' : '') +
          '</div>' +
          '<div class="field"><label>Nama Shift <span class="req">*</span></label>' +
            '<input type="text" id="sfName" value="' + esc(isEdit ? shift.name : '') + '" placeholder="Shift Pagi"></div>' +
          '<div class="field"><label>Jam Mulai <span class="req">*</span></label>' +
            '<input type="time" id="sfStart" value="' + esc(isEdit ? String(shift.start_time).slice(0, 5) : '08:00') + '"></div>' +
          '<div class="field"><label>Jam Selesai <span class="req">*</span></label>' +
            '<input type="time" id="sfEnd" value="' + esc(isEdit ? String(shift.end_time).slice(0, 5) : '17:00') + '">' +
            '<span class="help">Bila jam selesai lebih kecil dari jam mulai, shift dihitung lintas tengah malam (mis. 22:00 - 06:00).</span></div>' +
          '<div class="field"><label>Istirahat Mulai</label>' +
            '<input type="time" id="sfBreakStart" value="' + esc(isEdit && shift.break_start ? String(shift.break_start).slice(0, 5) : '12:00') + '"></div>' +
          '<div class="field"><label>Istirahat Selesai</label>' +
            '<input type="time" id="sfBreakEnd" value="' + esc(isEdit && shift.break_end ? String(shift.break_end).slice(0, 5) : '13:00') + '"></div>' +
          '<div class="field"><label>Toleransi Telat (menit)</label>' +
            '<input type="number" id="sfLate" value="' + esc(isEdit ? shift.late_tolerance_min : 10) + '" min="0" max="240"></div>' +
          '<div class="field"><label>Maksimum Jam Kerja (menit)</label>' +
            '<input type="number" id="sfMaxWork" value="' + esc(isEdit ? (shift.max_work_minutes || 600) : 600) + '" min="60" max="1440"></div>' +
        '</div>' +

        '<div class="divider"></div>' +
        '<div class="field"><label>Hari Kerja <span class="req">*</span></label>' +
          '<div class="row" id="sfDays">' +
            /* Hanya 1..6 (Senin-Sabtu). Hari Minggu sengaja tidak ada karena
               Minggu tidak pernah boleh dipilih sebagai hari kerja. */
            WORK_DAY_NAMES.slice(0, 6).map(function (name, i) {
              var day = i + 1;
              var id = 'day' + day;
              return '<div class="field checkbox"><input type="checkbox" id="' + id + '" value="' + day + '"' +
                (checkedDays[day] ? ' checked' : '') + '><label for="' + id + '">' + esc(name) + '</label></div>';
            }).join('') +
          '</div>' +
          '<span class="help">Hari Minggu selalu libur dan tidak bisa dipilih.</span>' +
        '</div>' +
        '<div class="field checkbox">' +
          '<input type="checkbox" id="sfActive"' + (!isEdit || Number(shift.is_active) === 1 ? ' checked' : '') + '>' +
          '<label for="sfActive">Shift aktif</label>' +
        '</div>',

      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Simpan Shift',
          className: 'primary',
          onClick: function (el) {
            var code = el.querySelector('#sfCode').value.trim() || (isEdit ? shift.code : '');
            var name = el.querySelector('#sfName').value.trim();
            var start = el.querySelector('#sfStart').value;
            var end = el.querySelector('#sfEnd').value;

            if (!code) { App.toast('Kode shift wajib diisi.', 'error'); return false; }
            if (!name) { App.toast('Nama shift wajib diisi.', 'error'); return false; }
            if (!start || !end) { App.toast('Jam mulai dan selesai wajib diisi.', 'error'); return false; }

            var breakStart = el.querySelector('#sfBreakStart').value;
            var breakEnd = el.querySelector('#sfBreakEnd').value;
            if ((breakStart && !breakEnd) || (!breakStart && breakEnd)) {
              App.toast('Jam istirahat mulai dan selesai harus diisi berdua atau kosong berdua.', 'error');
              return false;
            }

            var workDays = el.querySelectorAll('#sfDays input:checked');
            if (workDays.length === 0) { App.toast('Pilih minimal satu hari kerja.', 'error'); return false; }

            var daysValue = [];
            workDays.forEach(function (cb) { daysValue.push(Number(cb.value)); });

            var payload = {
              code: code,
              name: name,
              start_time: start,
              end_time: end,
              break_start: breakStart || null,
              break_end: breakEnd || null,
              late_tolerance_min: Number(el.querySelector('#sfLate').value) || 0,
              max_work_minutes: Number(el.querySelector('#sfMaxWork').value) || 600,
              work_days: daysValue.slice().sort(function (a, b) { return a - b; }).join(','),
              is_active: el.querySelector('#sfActive').checked ? 1 : 0,
            };

            var request = isEdit ? api.put('/shifts/' + shift.id, payload) : api.post('/shifts', payload);
            request
              .then(function () {
                App.toast(isEdit ? 'Shift diperbarui.' : 'Shift ditambahkan.', 'success');
                el.closeModal();
                load();
                api.get('/auth/meta').then(function (res) { App.state.meta = res.data; }).catch(function () {});
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

  function doDelete(shift) {
    App.confirm({
      title: 'Hapus shift',
      heading: 'Hapus shift ' + shift.name + '?',
      message: 'Karyawan yang memakai shift ini akan kehilangan shift default. Jadwal yang sudah dibuat tidak berubah.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/shifts/' + shift.id)
          .then(function (res) {
            App.toast(res.message || 'Shift dihapus.', 'success');
            load();
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }
})();
