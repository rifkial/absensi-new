/* =============================================================================
 * Halaman DASHBOARD
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  window.Pages.dashboard = function (root) {
    var rangeDays = 14;
    var data = null;

    function shell() {
      root.innerHTML =
        '<div class="toolbar">' +
          '<div class="field">' +
            '<label>Periode Ringkasan</label>' +
            '<select id="dashDays">' +
              '<option value="7">7 hari terakhir</option>' +
              '<option value="14" selected>14 hari terakhir</option>' +
              '<option value="30">30 hari terakhir</option>' +
              '<option value="90">90 hari terakhir</option>' +
            '</select>' +
          '</div>' +
          '<div class="grow"></div>' +
          '<div class="btn-group">' +
            (App.can('attendance:write')
              ? '<button class="btn" id="btnBackfill">Hitung Ulang Rekap (30 hari)</button>' +
                '<button class="btn primary" id="btnSyncAll">Sinkron Semua Mesin</button>'
              : '') +
            '<button class="btn" id="btnRefresh">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
        '<div id="dashBody">' + App.loading('Mengambil data...') + '</div>';

      var sel = document.getElementById('dashDays');
      sel.value = String(rangeDays);
      sel.addEventListener('change', function () {
        rangeDays = Number(sel.value) || 14;
        load();
      });

      document.getElementById('btnRefresh').addEventListener('click', load);

      var backfill = document.getElementById('btnBackfill');
      if (backfill) backfill.addEventListener('click', doBackfill);

      var syncAll = document.getElementById('btnSyncAll');
      if (syncAll) syncAll.addEventListener('click', doSyncAll);
    }

    var dashCtrl = null;

    function load() {
      var body = document.getElementById('dashBody');
      if (!body) return;
      if (dashCtrl) { try { dashCtrl.abort(); } catch (e) {} }
      dashCtrl = (typeof AbortController === 'function') ? new AbortController() : null;
      body.innerHTML = App.loading('Mengambil data...');
      api.get('/attendance/dashboard', { days: rangeDays }, dashCtrl ? { signal: dashCtrl.signal } : null)
        .then(function (res) {
          if (dashCtrl && dashCtrl.signal.aborted) return;
          data = res.data;
          paint();
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          if (dashCtrl && dashCtrl.signal.aborted) return;
          var b = document.getElementById('dashBody');
          if (!b) return;
          b.innerHTML =
            '<div class="card"><div class="empty-state">' +
              '<div class="big">&#9888;</div>' +
              '<div><strong>Gagal memuat dashboard.</strong></div>' +
              '<div class="small muted mt">' + esc(err.message) + '</div>' +
            '</div></div>';
        });
    }

    function paint() {
      var summary = data.summary || {};
      var period = summary.by_status || {};
      var todayStatus = (data.today && data.today.by_status) || {};
      var emp = data.employees || {};
      var dev = data.devices || [];
      var range = (summary.range && summary.range.from) ? summary.range : data.range;

      var activeDevices = dev.filter(function (d) { return Number(d.is_active) === 1; });
      var onlineDevices = activeDevices.filter(function (d) { return d.last_sync_status === 'success'; });
      var staleDevices = activeDevices.filter(function (d) {
        if (!d.last_sync_at) return true;
        return (Date.now() - new Date(String(d.last_sync_at).replace(' ', 'T')).getTime()) > 2 * 3600 * 1000;
      });

      var dinasToday = (Number(todayStatus.dinas_luar) || 0) + (Number(todayStatus.dinas_dalam) || 0);

      root.querySelector('#dashBody').innerHTML =
        '<div class="stat-grid">' +
          statCard('success', 'Hadir Hari Ini', App.formatNumber((todayStatus.hadir || 0) + dinasToday), 'dari ' + App.formatNumber(emp.aktif || 0) + ' karyawan, termasuk dinas ' + App.formatNumber(dinasToday) + ' (luar ' + App.formatNumber(todayStatus.dinas_luar || 0) + ', dalam ' + App.formatNumber(todayStatus.dinas_dalam || 0) + ')') +
          statCard('warning', 'Telat Hari Ini', App.formatNumber(todayStatus.telat || 0), 'keterlambatan masuk kerja') +
          statCard('info', 'Izin / Sakit', App.formatNumber((todayStatus.izin || 0) + (todayStatus.sakit || 0)), 'izin ' + App.formatNumber(todayStatus.izin || 0) + ', sakit ' + App.formatNumber(todayStatus.sakit || 0)) +
          statCard('danger', 'Alpa Hari Ini', App.formatNumber(todayStatus.alpa || 0), 'tidak hadir tanpa keterangan') +
          statCard('', 'Belum Absen', App.formatNumber(todayStatus.belum || 0), 'scan belum tercatat hari ini') +
          statCard('purple', 'Total Karyawan', App.formatNumber(emp.aktif || 0), App.formatNumber(emp.total || 0) + ' total, ' + App.formatNumber(emp.nonaktif || 0) + ' nonaktif') +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="card">' +
            '<div class="card-header">' +
              '<div><h2 class="card-title">Tren Kehadiran</h2>' +
              '<p class="card-subtitle">' + esc(App.fmtDate(range.from)) + ' s.d. ' + esc(App.fmtDate(range.to)) + '</p></div>' +
            '</div>' +
            '<div class="card-body" id="dashChart">' + App.chart(data.trend || []) + '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-header">' +
              '<div><h2 class="card-title">Ringkasan Periode</h2>' +
              '<p class="card-subtitle">Akumulasi ' + rangeDays + ' hari terakhir</p></div>' +
            '</div>' +
            '<div class="card-body tight">' +
              App.table([
                { key: 'label', label: 'Status' },
                { key: 'total', label: 'Jumlah', align: 'right', render: function (r) { return App.formatNumber(r.total); } },
                { key: 'avg', label: 'Rata-rata/hari', align: 'right', render: function (r) { return (Number(r.avg) || 0).toFixed(1); } },
                { key: 'pct', label: 'Persentase', align: 'right', render: function (r) { return r.pct + '%'; } },
              ], buildPeriodRows(period), { empty: 'Belum ada rekap pada periode ini.' }) +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="card">' +
            '<div class="card-header">' +
              '<div><h2 class="card-title">Status Mesin Fingerprint</h2>' +
              '<p class="card-subtitle">' + activeDevices.length + ' perangkat aktif, ' + onlineDevices.length + ' sinkronisasi terakhir berhasil</p></div>' +
              '<a class="btn sm" href="#/devices">Kelola</a>' +
            '</div>' +
            '<div class="card-body tight">' +
              App.table([
                { key: 'name', label: 'Nama' },
                { key: 'protocol', label: 'Protokol' },
                { key: 'last_sync_at', label: 'Sync Terakhir', render: function (r) {
                  return '<span class="small">' + esc(App.fmtRelative(r.last_sync_at)) + '</span>';
                } },
                { key: 'last_sync_status', label: 'Status', render: function (r) {
                  if (!r.last_sync_status) return '<span class="badge idle">Belum Sync</span>';
                  if (r.last_sync_status === 'success') return '<span class="badge success">Berhasil</span>';
                  if (r.last_sync_status === 'running') return '<span class="badge running">Proses</span>';
                  return '<span class="badge failed" title="' + escAttr(r.last_sync_message || '') + '">Gagal</span>';
                } },
              ], dev, {
                empty: 'Belum ada mesin fingerprint. Tambahkan lewat menu Mesin Fingerprint.',
                emptyIcon: '&#128421;',
              }) +
            '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-header">' +
              '<div><h2 class="card-title">Scan Terbaru</h2>' +
              '<p class="card-subtitle">12 pencatatan terakhir dari mesin</p></div>' +
              '<a class="btn sm" href="#/attendance">Lihat Semua</a>' +
            '</div>' +
            '<div class="card-body tight">' +
              App.table([
                { key: 'log_time', label: 'Waktu', render: function (r) {
                  return '<span class="nowrap small">' + esc(App.fmtTime(r.log_time)) + '</span>';
                } },
                { key: 'employee_name', label: 'Karyawan', render: function (r) {
                  return r.employee_name
                    ? '<div>' + esc(r.employee_name) + '</div><div class="small faint">' + esc(r.employee_code || '') + '</div>'
                    : '<span class="faint">Tidak dikenal (' + esc(r.device_user_id || '-') + ')</span>';
                } },
                { key: 'log_state', label: 'Jenis', render: function (r) {
                  return '<span class="badge ' + (Number(r.log_state) === 1 ? 'warning' : 'success') + '">' +
                    esc(r.log_state_label || App.LOG_STATE_LABELS[r.log_state] || r.log_state) + '</span>';
                } },
                { key: 'verify_mode', label: 'Verifikasi', render: function (r) {
                  return '<span class="small muted">' + esc(r.verify_mode_label || '-') + '</span>';
                } },
              ], data.recent_logs || [], { empty: 'Belum ada scan masuk dari mesin.' }) +
            '</div>' +
          '</div>' +
        '</div>' +

        (staleDevices.length > 0
          ? '<div class="card"><div class="card-body">' +
              '<div class="callout warning"><strong>Perhatian: ' + staleDevices.length + ' mesin belum sinkron lebih dari 2 jam</strong>' +
              esc(staleDevices.map(function (d) { return d.name; }).join(', ')) +
              '. Periksa koneksi jaringan atau tombol Sinkron Sekarang pada menu Perangkat.' +
            '</div></div></div>'
          : '') +

        renderNotifyCard(data.notify);

      // Notifikasi per karyawan
      var notifyBtn = document.getElementById('btnNotifyLate');
      if (notifyBtn) {
        notifyBtn.addEventListener('click', function () {
          notifyBtn.disabled = true;
          notifyBtn.innerHTML = '<span class="spinner"></span> Mengirim...';
          api.post('/attendance/notify/late', { date: App.today() })
            .then(function (res) {
              var r = res.data || {};
              App.toast('Notifikasi dikirim ke ' + App.formatNumber(r.sent || 0) + ' karyawan, gagal ' +
                App.formatNumber(r.failed || 0) + '.', r.sent > 0 ? 'success' : 'warning');
            })
            .catch(function (err) { App.toast(err.message, 'error'); })
            .then(function () {
              notifyBtn.disabled = false;
              notifyBtn.textContent = 'Kirim Notifikasi Telat';
            });
        });
      }
    }

    function escAttr(value) {
      return esc(value);
    }

    function statCard(kind, label, value, hint) {
      return '<div class="stat ' + kind + '">' +
        '<div class="stat-label">' + esc(label) + '</div>' +
        '<div class="stat-value">' + esc(value) + '</div>' +
        '<div class="stat-hint">' + esc(hint) + '</div>' +
      '</div>';
    }

    function buildPeriodRows(s) {
      var order = ['hadir', 'telat', 'dinas_luar', 'dinas_dalam', 'izin', 'sakit', 'cuti', 'alpa', 'belum', 'hari_libur'];
      var out = [];
      var totalAll = order.reduce(function (sum, k) { return sum + (Number(s[k]) || 0); }, 0);

      order.forEach(function (key) {
        var value = Number(s[key]) || 0;
        if (value === 0) return;
        out.push({
          label: App.STATUS_LABELS[key] || key,
          total: value,
          avg: (value / Math.max(1, rangeDays)).toFixed(1),
          pct: totalAll > 0 ? ((value / totalAll) * 100).toFixed(1) : '0.0',
        });
      });
      return out;
    }

    function renderNotifyCard(notify) {
      if (!notify) return '';
      var channels = notify.channels || [];
      var enabled = channels.filter(function (c) { return c.enabled; });

      return '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Notifikasi</h2>' +
          '<p class="card-subtitle">Kirim pengingat otomatis ke karyawan</p></div>' +
          (App.can('notify:send') ? '<button class="btn sm" id="btnNotifyLate">Kirim Notifikasi Telat</button>' : '') +
        '</div>' +
        '<div class="card-body">' +
          (enabled.length === 0
            ? '<div class="callout warning"><strong>Belum ada channel notifikasi aktif</strong>' +
              'Isi kredensial WhatsApp API atau SMTP pada berkas <code>.env</code>, lalu restart server. ' +
              'Pengiriman via WhatsApp memerlukan gateway atau layanan pihak ketiga.</div>'
            : '<div class="row">' + enabled.map(function (c) {
                return '<span class="badge success">' + esc(c.label) + ' aktif</span>';
              }).join('') + '</div>') +
        '</div>' +
      '</div>';
    }

    function doBackfill() {
      if (!App.perm('attendance:write')) return;
      App.confirm({
        title: 'Hitung ulang rekap',
        heading: 'Proses 30 hari terakhir?',
        message: 'Seluruh rekap 30 hari terakhir akan dihitung ulang dari log mentah mesin. Log yang sudah dikoreksi manual akan ditimpa.',
        confirmLabel: 'Proses Sekarang',
        onConfirm: function () {
          var btn = document.getElementById('btnBackfill');
          if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Proses...'; }

          api.post('/attendance/backfill', { days: 30 })
            .then(function (res) {
              App.toast('Rekap ' + App.formatNumber((res.data && res.data.updated) || 0) + ' baris berhasil diperbarui.', 'success');
              load();
            })
            .catch(function (err) { App.toast(err.message, 'error'); })
            .then(function () {
              if (btn) { btn.disabled = false; btn.textContent = 'Hitung Ulang Rekap (30 hari)'; }
            });
        },
      });
    }

    function doSyncAll() {
      if (!App.perm('devices:sync')) return;
      App.confirm({
        title: 'Sinkronisasi semua mesin',
        heading: 'Tarik log dari semua mesin?',
        message: 'Semua perangkat aktif akan dibaca. Proses ini bisa memakan waktu beberapa detik per mesin.',
        confirmLabel: 'Mulai Sinkronisasi',
        onConfirm: function () {
          var btn = document.getElementById('btnSyncAll');
          if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sync...'; }

          api.post('/devices/sync-all', { regenerate_days: 2 })
            .then(function (res) {
              App.toast(res.message || 'Sinkronisasi berjalan di background.', 'info');
              load();
            })
            .catch(function (err) { App.toast(err.message, 'error'); })
            .then(function () {
              if (btn) { btn.disabled = false; btn.textContent = 'Sinkron Semua Mesin'; }
            });
        },
      });
    }

    shell();
    load();
  };
})();
