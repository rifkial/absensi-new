/* =============================================================================
 * Halaman ABSENSI (papan harian, rekap, log mentah)
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var tab = 'board';
  var filters = { date: App.today(), from: App.startOfMonth(), to: App.today(), department_id: '', status: '', page: 1, per_page: 50 };
  var rows = [];
  var meta = {};

  window.Pages.attendance = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            tabButton('board', 'Papan Harian') +
            tabButton('daily', 'Rekap Berulang') +
            tabButton('logs', 'Log Mentah') +
          '</div>' +
          '<div class="btn-group">' +
            (App.can('attendance:write') ? '<button class="btn" id="btnRegen">Hitung Ulang Rekap</button>' : '') +
            (App.can('attendance:write') ? '<button class="btn" id="btnManualLog">+ Log Manual</button>' : '') +
            '<button class="btn" id="btnLoad">&#8635; Muat</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="attFilter"></div>' +
      '<div class="card"><div class="card-body tight" id="attTable">' + App.loading('Memuat data...') + '</div><div id="attPager"></div></div>';

    document.querySelectorAll('#pageContent [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        window.Pages.attendance(root);
      });
    });

    document.getElementById('btnLoad').addEventListener('click', function () { renderFilter(); load(); });

    var regen = document.getElementById('btnRegen');
    if (regen) regen.addEventListener('click', doRegenerate);

    var manual = document.getElementById('btnManualLog');
    if (manual) manual.addEventListener('click', openManualLog);

    renderFilter();
    load();
  };

  function tabButton(key, label) {
    return '<button class="btn ' + (tab === key ? 'primary' : '') + '" data-tab="' + key + '">' + esc(label) + '</button>';
  }

  function renderFilter() {
    var box = document.getElementById('attFilter');
    var meta_ = App.state.meta || { departments: [] };

    var controls;
    if (tab === 'board') {
      controls =
        '<div class="field"><label>Tanggal</label><input type="date" id="fDate" value="' + esc(filters.date) + '"></div>' +
        deptSelect(meta_) +
        '<div class="field" style="min-width:auto"><label>&nbsp;</label>' +
          '<div class="btn-group">' +
            '<button class="btn" data-nav="-1">&#8592; Kemarin</button>' +
            '<button class="btn" data-nav="0">Hari Ini</button>' +
            '<button class="btn" data-nav="1">Besok &#8594;</button>' +
          '</div>' +
        '</div>';
    } else if (tab === 'daily') {
      controls =
        '<div class="field"><label>Dari</label><input type="date" id="fFrom" value="' + esc(filters.from) + '"></div>' +
        '<div class="field"><label>Sampai</label><input type="date" id="fTo" value="' + esc(filters.to) + '"></div>' +
        deptSelect(meta_) +
        '<div class="field"><label>Status</label><select id="fStatus">' +
          '<option value="">Semua Status</option>' +
['hadir', 'telat', 'dinas_luar', 'izin', 'sakit', 'cuti', 'alpa', 'belum', 'hari_libur'].map(function (s) {
    return '<option value="' + s + '"' + (filters.status === s ? ' selected' : '') + '>' + esc(App.STATUS_LABELS[s] || s) + '</option>';
          }).join('') +
        '</select></div>';
    } else {
      controls =
        '<div class="field"><label>Dari</label><input type="date" id="fFrom" value="' + esc(filters.from) + '"></div>' +
        '<div class="field"><label>Sampai</label><input type="date" id="fTo" value="' + esc(filters.to) + '"></div>' +
        '<div class="field grow"><label>&nbsp;</label><span class="help">Log mentah adalah setiap scan yang masuk dari mesin, termasuk scan yang tidak terhubung ke master karyawan.</span></div>';
    }

    box.innerHTML = '<div class="card"><div class="card-body"><div class="toolbar" style="margin:0">' +
      controls +
      '<div class="grow"></div>' +
      '<div class="field" style="min-width:auto"><label>&nbsp;</label><button class="btn primary" id="fApply">Terapkan Filter</button></div>' +
    '</div></div></div>';

    var apply = document.getElementById('fApply');
    if (apply) apply.addEventListener('click', applyFilter);

    box.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        var nav = Number(b.getAttribute('data-nav'));
        filters.date = nav === 0 ? App.today() : App.addDays(filters.date, nav);
        renderFilter();
        load();
      });
    });
  }

  function deptSelect(meta_) {
    return '<div class="field"><label>Unit Kerja</label><select id="fDept">' +
      '<option value="">Semua</option>' +
      (meta_.departments || []).map(function (d) {
        return '<option value="' + d.id + '"' + (String(filters.department_id) === String(d.id) ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('') +
    '</select></div>';
  }

  function applyFilter() {
    if (tab === 'board') {
      filters.date = document.getElementById('fDate').value || App.today();
    } else {
      filters.from = document.getElementById('fFrom').value || filters.from;
      filters.to = document.getElementById('fTo').value || filters.to;
      if (filters.to < filters.from) {
        App.toast('Tanggal "sampai" tidak boleh lebih awal dari "dari".', 'error');
        return;
      }
    }

    var dept = document.getElementById('fDept');
    if (dept) filters.department_id = dept.value;

    var status = document.getElementById('fStatus');
    if (status) filters.status = status.value;

    filters.page = 1;
    renderFilter();
    load();
  }

  function load() {
    var box = document.getElementById('attTable');
    box.innerHTML = App.loading('Memuat data...');

    var request;
    if (tab === 'board') {
      request = api.get('/attendance/board', {
        date: filters.date,
        department_id: filters.department_id,
      });
    } else if (tab === 'daily') {
      request = api.get('/attendance/daily', {
        from: filters.from,
        to: filters.to,
        department_id: filters.department_id,
        status: filters.status,
        page: filters.page,
        per_page: filters.per_page,
      });
    } else {
      request = api.get('/attendance/logs', {
        from: filters.from,
        to: filters.to,
        limit: 300,
      });
    }

    request
      .then(function (res) {
        if (tab === 'logs') {
          rows = res.data || [];
          meta = {};
          paintLogs();
        } else {
          rows = res.data || [];
          meta = res.meta || {};
          paintBoard();
        }
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  // ---------------------------------------------------------------- Papan harian

  function paintBoard() {
    var box = document.getElementById('attTable');

    // Ringkasan per status untuk tanggal terpilih.
    var counts = countByStatus(rows);
    var summaryHtml = '<div class="stat-grid">' +
      stat('success', 'Hadir', counts.hadir) +
      stat('warning', 'Telat', counts.telat) +
      stat('info', 'Izin', counts.izin) +
      stat('purple', 'Sakit', counts.sakit) +
      stat('danger', 'Alpa', counts.alpa) +
      stat('', 'Belum', counts.belum) +
      stat('', 'Libur', counts.hari_libur) +
      stat('info', 'Total', rows.length) +
    '</div>';

    var columns = [
      { key: 'employee_code', label: 'Kode', mono: true },
      { key: 'name', label: 'Nama', render: function (r) {
        return '<div style="font-weight:500">' + esc(r.employee_name || '-') + '</div>' +
          '<div class="small faint">' + esc(r.department_name || '') + '</div>';
      } },
      { key: 'device_user_id', label: 'PIN', mono: true },
      { key: 'first_in', label: 'Masuk', render: function (r) { return timeCell(r.first_in, r.late_minutes); } },
      { key: 'break_start', label: 'Istirahat', render: function (r) { return timeCell(r.break_start, 0); } },
      { key: 'break_end', label: 'Kembali', render: function (r) { return timeCell(r.break_end, 0); } },
      { key: 'first_out', label: 'Pulang', render: function (r) { return timeCell(r.first_out, 0); } },
      { key: 'work_minutes', label: 'Durasi', align: 'right', render: function (r) { return App.fmtMinutes(r.work_minutes); } },
      { key: 'overtime_minutes', label: 'Lembur', align: 'right', render: function (r) {
        var v = Number(r.overtime_minutes) || 0;
        return v > 0 ? '<span class="badge warning">' + App.fmtMinutes(v) + '</span>' : '<span class="faint">-</span>';
      } },
      { key: 'status', label: 'Status', render: function (r) { return App.badge(r.status); } },
      { key: 'aksi', label: '', width: '120px', render: function (r) {
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="detail" data-id="' + r.employee_id + '">Detail</button>' +
          (App.can('attendance:write') ? '<button class="btn sm" data-act="edit" data-id="' + r.employee_id + '">Koreksi</button>' : '') +
        '</div>';
      } },
    ];

    box.innerHTML = summaryHtml + App.table(columns, rows, {
      empty: 'Tidak ada data rekap untuk tanggal ' + App.fmtDate(filters.date) + '. Klik "Hitung Ulang Rekap" untuk membuat data.',
      emptyIcon: '&#128197;',
    });

    document.getElementById('attPager').innerHTML = '';

    bindRowActions();
  }

  function timeCell(value, lateMinutes) {
    if (!value) return '<span class="faint">-</span>';
    var late = Number(lateMinutes) || 0;
    return '<span class="nowrap">' + esc(App.fmtTime(value)) + '</span>' +
      (late > 0 ? ' <span class="badge telat" title="Terlambat ' + late + ' menit">+' + late + "'</span>" : '');
  }

  function stat(kind, label, value) {
    return '<div class="stat ' + kind + '">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + App.formatNumber(value) + '</div>' +
    '</div>';
  }

  function countByStatus(list) {
    var out = { hadir: 0, telat: 0, izin: 0, sakit: 0, cuti: 0, alpa: 0, belum: 0, hari_libur: 0 };
    list.forEach(function (r) {
      var key = String(r.status || 'belum');
      if (out[key] === undefined) out[key] = 0;
      out[key] += 1;
    });
    return out;
  }

  // ---------------------------------------------------------------- Rekap berulang

  function paintDaily() {
    var box = document.getElementById('attTable');

    var columns = [
      { key: 'work_date', label: 'Tanggal', render: function (r) {
        return '<div class="nowrap">' + esc(App.fmtDate(r.work_date)) + '</div>' +
          '<div class="small faint">' + esc(App.DAY_NAMES[new Date(r.work_date + 'T00:00:00').getDay()]) + '</div>';
      } },
      { key: 'employee_code', label: 'Kode', mono: true },
      { key: 'name', label: 'Nama', render: function (r) { return esc(r.employee_name || '-'); } },
      { key: 'department_name', label: 'Unit Kerja', render: function (r) { return esc(r.department_name || '-'); } },
      { key: 'first_in', label: 'Masuk', render: function (r) { return App.fmtTime(r.first_in); } },
      { key: 'first_out', label: 'Pulang', render: function (r) { return App.fmtTime(r.first_out); } },
      { key: 'late_minutes', label: 'Telat', align: 'right', render: function (r) {
        var v = Number(r.late_minutes) || 0;
        return v > 0 ? '<span class="badge telat">' + v + ' menit</span>' : '<span class="faint">-</span>';
      } },
      { key: 'work_minutes', label: 'Durasi', align: 'right', render: function (r) { return App.fmtMinutes(r.work_minutes); } },
      { key: 'overtime_minutes', label: 'Lembur', align: 'right', render: function (r) {
        var v = Number(r.overtime_minutes) || 0;
        return v > 0 ? App.fmtMinutes(v) : '<span class="faint">-</span>';
      } },
      { key: 'status', label: 'Status', render: function (r) { return App.badge(r.status); } },
      { key: 'note', label: 'Catatan', render: function (r) {
        return r.note
          ? '<span class="small muted" title="' + escAttr(r.note) + '">' + esc(String(r.note).slice(0, 30)) + '</span>'
          : (Number(r.is_auto) === 0 ? '<span class="badge warning">Koreksi Manual</span>' : '<span class="faint">-</span>');
      } },
    ];

    box.innerHTML = App.table(columns, rows, {
      empty: 'Tidak ada rekap pada rentang tanggal tersebut.',
      emptyIcon: '&#128197;',
    });

    var pager = document.getElementById('attPager');
    if ((meta.total_pages || 0) > 1) {
      pager.innerHTML = '<div class="pagination">' +
        '<span>' + App.formatNumber(meta.total) + ' baris | Halaman ' + meta.page + ' dari ' + meta.total_pages + '</span>' +
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

    bindRowActions();
  }

  // ---------------------------------------------------------------- Log mentah

  function paintLogs() {
    var box = document.getElementById('attTable');

    var unmatched = rows.filter(function (r) { return !r.employee_id; }).length;
    var header = '<div class="callout' + (unmatched > 0 ? ' warning' : '') + '">' +
      '<strong>' + rows.length + ' baris log</strong>' +
      (unmatched > 0
        ? App.formatNumber(unmatched) + ' baris tidak terhubung ke master karyawan (PIN mesin tidak cocok). ' +
          'Perbaiki PIN pada data karyawan agar log ikut terhitung.'
        : 'Semua log terhubung ke master karyawan.') +
    '</div>';

    var columns = [
      { key: 'log_time', label: 'Waktu', render: function (r) {
        return '<div class="nowrap">' + esc(App.fmtTime(r.log_time)) + '</div>' +
          '<div class="small faint nowrap">' + esc(App.fmtDate(r.log_time)) + '</div>';
      } },
      { key: 'employee_name', label: 'Karyawan', render: function (r) {
        return r.employee_name
          ? '<div>' + esc(r.employee_name) + '</div><div class="small faint">' + esc(r.employee_code || '') + '</div>'
          : '<span class="badge failed">Tidak dikenal</span>';
      } },
      { key: 'device_user_id', label: 'PIN Mesin', mono: true },
      { key: 'log_state', label: 'Jenis Scan', render: function (r) {
        var s = Number(r.log_state);
        var cls = s === 1 ? 'warning' : (s === 5 ? 'failed' : 'success');
        return '<span class="badge ' + cls + '">' + esc(r.log_state_label || App.LOG_STATE_LABELS[s] || r.log_state) + '</span>';
      } },
      { key: 'verify_mode', label: 'Verifikasi', render: function (r) {
        return '<span class="small muted">' + esc(r.verify_mode_label || '-') + '</span>';
      } },
      { key: 'device_name', label: 'Mesin', render: function (r) { return esc(r.device_name || '-'); } },
      { key: 'source', label: 'Sumber', render: function (r) {
        var map = { sync: 'TCP Sync', push: 'PUSH', import: 'Impor File', manual: 'Manual' };
        return '<span class="small faint">' + esc(map[r.source] || r.source) + '</span>';
      } },
      { key: 'work_code', label: 'Kode Kerja', mono: true },
    ];

    box.innerHTML = header + App.table(columns, rows, {
      empty: 'Belum ada log mentah pada rentang tanggal tersebut.',
      emptyIcon: '&#128190;',
    });

    document.getElementById('attPager').innerHTML = '';
  }

  function escAttr(v) {
    return esc(v);
  }

  // ---------------------------------------------------------------- Aksi baris

  function bindRowActions() {
    var box = document.getElementById('attTable');
    box.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var act = b.getAttribute('data-act');
        if (act === 'detail') openDetail(id, tab === 'board' ? filters.date : filters.from);
        else if (act === 'edit') openOverride(id, tab === 'board' ? filters.date : filters.from);
      });
    });
  }

  function openDetail(employeeId, date) {
    App.modal({
      title: 'Detail Absensi Harian',
      size: 'large',
      bodyHtml: '<div id="attDetail">' + App.loading('Memuat...') + '</div>',
      actions: [{ label: 'Tutup' }],
      onMount: function (el) {
        var target = el.querySelector('#attDetail');
        Promise.all([
          api.get('/employees/' + employeeId),
          api.get('/attendance/detail/' + employeeId + '/' + date),
        ]).then(function (res) {
          var emp = res[0].data;
          var daily = res[1].daily || res[1].data || null;
          var logs = res[1].logs || [];
          var duty = res[1].duty || null;
          var shift = res[1].shift || null;
          var holiday = res[1].holiday || null;

          target.innerHTML =
            '<div class="grid-2">' +
              '<div>' +
                '<h4 style="margin:0 0 8px">Karyawan</h4>' +
                App.table([
                  { key: 'employee_code', label: 'Kode' },
                  { key: 'name', label: 'Nama' },
                  { key: 'department_name', label: 'Unit Kerja' },
                  { key: 'device_user_id', label: 'PIN Mesin' },
                ], [emp], { empty: '-' }) +
                '<h4 style="margin:16px 0 8px">Rekap Tanggal ' + esc(App.fmtDate(date)) + '</h4>' +
                (daily
                  ? App.table([
{ key: 'status', label: 'Status', render: function (r) { return App.badge(r.status); } },
                       { key: 'first_in', label: 'Masuk', render: function (r) { return App.fmtTime(r.first_in); } },
                      { key: 'first_out', label: 'Pulang', render: function (r) { return App.fmtTime(r.first_out); } },
                      { key: 'late_minutes', label: 'Telat (mnt)', align: 'right' },
                      { key: 'early_minutes', label: 'Pulang Awal (mnt)', align: 'right' },
                      { key: 'work_minutes', label: 'Durasi (mnt)', align: 'right' },
                      { key: 'overtime_minutes', label: 'Lembur (mnt)', align: 'right' },
                      { key: 'note', label: 'Catatan', render: function (r) { return esc(r.note || '-'); } },
                    ], [daily], { empty: 'Belum ada rekap.' })
                  : '<div class="callout warning">Rekap belum dihitung untuk tanggal ini. Klik "Hitung Ulang Rekap".</div>') +
              '</div>' +
              '<div>' +
                (duty
                  ? '<h4 style="margin:0 0 8px">Dinas (GPS + Selfie)</h4>' +
                    '<div class="callout">Check-in ' + esc(App.fmtTime(duty.check_in_at)) + ' - ' +
                    'Check-out ' + esc(duty.check_out_at ? App.fmtTime(duty.check_out_at) : '-') + '. ' +
                    (duty.selfie_url
                      ? '<button class="btn sm" data-duty-selfie="' + esc(duty.selfie_url) + '">Foto In</button> '
                      : '<span class="faint">(tanpa foto in)</span> ') +
                    (duty.check_out_at
                      ? (duty.selfie_out_url
                        ? '<button class="btn sm" data-duty-selfie="' + esc(duty.selfie_out_url) + '">Foto Out</button>'
                        : '<span class="faint">(tanpa foto out)</span>')
                      : '<span class="faint">(belum check-out)</span>') +
                    '</div>'
                  : '') +
                '<h4 style="margin:0 0 8px">Scan pada Tanggal Ini</h4>' +
                App.table([
                  { key: 'log_time', label: 'Waktu', render: function (r) { return esc(App.fmtTime(r.log_time)); } },
                  { key: 'log_state', label: 'Jenis', render: function (r) {
                    return esc(r.log_state_label || App.LOG_STATE_LABELS[r.log_state] || r.log_state);
                  } },
                  { key: 'verify_mode', label: 'Verifikasi', render: function (r) {
                    return esc(r.verify_mode_label || App.VERIFY_LABELS[r.verify_mode] || '-');
                  } },
                  { key: 'work_code', label: 'Kode', mono: true },
                ], logs, { empty: 'Tidak ada scan pada tanggal ini.', emptyIcon: '&#128190;' }) +
                (holiday ? '<div class="callout mt"><strong>Hari Libur: ' + esc(holiday.name) + '</strong>' +
                  (Number(holiday.is_workday) === 1
                    ? ' Tanggal ini ditandai tetap bekerja, jadi dihitung seperti hari biasa.'
                    : ' Tanggal ini otomatis berstatus Hari Libur dan tidak dihitung alpa.') +
                  '</div>' : '') +
                (shift ? '<div class="callout mt"><strong>Shift: ' + esc(shift.name || shift.shift_code || '-') + '</strong>' +
                  'Jam kerja ' + esc(App.fmtTime(shift.start_time)) + ' - ' + esc(App.fmtTime(shift.end_time)) +
                  (shift.break_start ? ', istirahat ' + esc(App.fmtTime(shift.break_start)) + ' - ' + esc(App.fmtTime(shift.break_end)) : '') +
                  '</div>' : '') +
              '</div>' +
            '</div>';

          Array.prototype.forEach.call(target.querySelectorAll('[data-duty-selfie]'), function (btn) {
            btn.addEventListener('click', function () {
              var url = btn.getAttribute('data-duty-selfie');
              fetch(url, { headers: { Authorization: 'Bearer ' + api.token } })
                .then(function (r) {
                  if (!r.ok) throw new Error('Foto tidak dapat dimuat (' + r.status + ').');
                  return r.blob();
                })
                .then(function (blob) {
                  var objectUrl = URL.createObjectURL(blob);
                  App.modal({
                    title: 'Foto Selfie Dinas',
                    bodyHtml: '<img src="' + objectUrl + '" alt="Selfie dinas" style="width:100%;border-radius:8px">',
                    actions: [{ label: 'Tutup' }],
                    onClose: function () { URL.revokeObjectURL(objectUrl); },
                  });
                })
                .catch(function (e) { App.toast(e.message, 'error'); });
            });
          });
        }).catch(function (err) {
          target.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
        });
      },
    });
  }

  // ---------------------------------------------------------------- Koreksi

  function openOverride(employeeId, date) {
    if (!App.perm('attendance:write')) return;

    App.modal({
      title: 'Koreksi Rekap Manual',
      bodyHtml:
        '<div class="callout warning"><strong>Perhatian</strong>' +
        'Koreksi manual akan menimpa hasil perhitungan otomatis dan diberi tanda "Koreksi Manual" pada laporan. ' +
        'Koreksi bisa dibatalkan dengan menghapus koreksi, lalu rekap dihitung ulang dari log mesin.' +
        '</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Tanggal</label><input type="date" id="ovDate" value="' + esc(date) + '" disabled></div>' +
          '<div class="field"><label>Status Baru <span class="req">*</span></label><select id="ovStatus">' +
            '<option value="hadir">Hadir</option>' +
            '<option value="telat">Telat</option>' +
            '<option value="dinas_luar">Dinas Luar Kota</option>' +
            '<option value="izin">Izin</option>' +
            '<option value="sakit">Sakit</option>' +
            '<option value="cuti">Cuti</option>' +
            '<option value="alpa">Alpa</option>' +
            '<option value="belum">Belum Absen</option>' +
          '</select></div>' +
        '</div>' +
        '<div class="field mt"><label>Alasan Koreksi</label><input type="text" id="ovNote" placeholder="mis. Mesin sedang rusak, scan manual"></div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Koreksi',
          className: 'primary',
          onClick: function (el) {
            var status = el.querySelector('#ovStatus').value;
            var note = el.querySelector('#ovNote').value.trim();
            var target = el.querySelector('#ovDate').value;

            api.put('/attendance/override/' + employeeId + '/' + target, { status: status, note: note })
              .then(function () {
                App.toast('Koreksi manual tersimpan.', 'success');
                el.closeModal();
                load();
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

  function doRegenerate() {
    if (!App.perm('attendance:write')) return;

    App.confirm({
      title: 'Hitung ulang rekap',
      heading: 'Hitung ulang rekap periode ini?',
      message: 'Seluruh baris rekap pada rentang tanggal di atas akan dihitung ulang dari log mentah mesin. Koreksi manual akan tetap dipertahankan (tidak ditimpa).',
      confirmLabel: 'Hitung Ulang',
      onConfirm: function () {
        var btn = document.getElementById('btnRegen');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Proses...'; }

        var payload = { department_id: filters.department_id || null };
        if (tab === 'board') {
          payload.from = filters.date;
          payload.to = filters.date;
        } else {
          payload.from = filters.from;
          payload.to = filters.to;
        }

        api.post('/attendance/generate', payload)
          .then(function (res) {
            App.toast((res.data && res.data.message) || 'Rekap diperbarui.', 'success');
            load();
          })
          .catch(function (err) { App.toast(err.message, 'error'); })
          .then(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Hitung Ulang Rekap'; }
          });
      },
    });
  }

  // ---------------------------------------------------------------- Log manual

  function openManualLog() {
    if (!App.perm('attendance:write')) return;

    App.modal({
      title: 'Tambah Log Absensi Manual',
      bodyHtml:
        '<div class="callout">Gunakan hanya bila karyawan tidak bisa scan karena alasan_force. ' +
        'Log manual ditandai dengan sumber "Manual" dan tetap bisa dihitung jadi rekap.</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Karyawan <span class="req">*</span></label><select id="mlEmp"><option value="">- pilih karyawan -</option></select></div>' +
          '<div class="field"><label>Waktu <span class="req">*</span></label><input type="datetime-local" id="mlTime" value="' + esc(App.nowInput()) + '"></div>' +
          '<div class="field"><label>Jenis Scan</label><select id="mlState">' +
            '<option value="0">Check-In (Masuk)</option>' +
            '<option value="1">Check-Out (Pulang)</option>' +
            '<option value="15">Check-In (Kartu)</option>' +
            '<option value="16">Check-Out (Kartu)</option>' +
          '</select></div>' +
          '<div class="field"><label>Verifikasi</label><select id="mlVerify">' +
            '<option value="0">Password</option>' +
            '<option value="1">Kartu</option>' +
            '<option value="2" selected>Sidik Jari</option>' +
            '<option value="3">Wajah</option>' +
          '</select></div>' +
        '</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Simpan Log',
          className: 'primary',
          onClick: function (el) {
            var employeeId = el.querySelector('#mlEmp').value;
            var time = el.querySelector('#mlTime').value;
            if (!employeeId) { App.toast('Pilih karyawan.', 'error'); return false; }
            if (!time) { App.toast('Waktu wajib diisi.', 'error'); return false; }

            api.post('/attendance/manual-log', {
              employee_id: Number(employeeId),
              log_time: time.replace('T', ' ') + ':00',
              log_state: Number(el.querySelector('#mlState').value),
              verify_mode: Number(el.querySelector('#mlVerify').value),
              work_code: 'MANUAL',
            })
              .then(function () {
                App.toast('Log manual tersimpan dan rekap diperbarui.', 'success');
                el.closeModal();
                load();
              })
              .catch(function (err) {
                App.toast(err.message, 'error');
                return false;
              });
            return false;
          },
        },
      ],
      onMount: function (el) {
        api.get('/employees/options/list')
          .then(function (res) {
            var select = el.querySelector('#mlEmp');
            (res.data || []).forEach(function (e) {
              var opt = document.createElement('option');
              opt.value = e.id;
              opt.textContent = e.employee_code + ' - ' + e.name + (e.device_user_id ? ' (PIN ' + e.device_user_id + ')' : ' (belum ada PIN)');
              select.appendChild(opt);
            });
          })
          .catch(function (err) {
            el.querySelector('#mlEmp').innerHTML = '<option value="">Gagal memuat: ' + esc(err.message) + '</option>';
          });
      },
    });
  }
})();
