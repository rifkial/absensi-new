/* =============================================================================
 * Halaman PERANGKAT (mesin fingerprint)
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var devices = [];
  var protocols = null;
  var syncStatus = null;

  window.Pages.devices = function (root) {
    root.innerHTML =
      '<div id="devAlert"></div>' +
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Mesin Fingerprint Terdaftar</h2>' +
          '<p class="card-subtitle" id="devSub">Memuat...</p></div>' +
          '<div class="btn-group">' +
            (App.can('devices:write') ? '<button class="btn primary" id="devAdd">+ Tambah Perangkat</button>' : '') +
            '<button class="btn" id="devSyncAll">Sinkron Semua</button>' +
            '<button class="btn" id="devScan">Pindai Jaringan</button>' +
            '<button class="btn" id="devReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body tight" id="devTable">' + App.loading('Memuat perangkat...') + '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Riwayat Sinkronisasi</h2>' +
          '<p class="card-subtitle">20 proses terakhir</p></div>' +
        '</div>' +
        '<div class="card-body tight" id="devHistory">' + App.loading('Memuat riwayat...') + '</div>' +
      '</div>';

    document.getElementById('devReload').addEventListener('click', loadAll);
    document.getElementById('devSyncAll').addEventListener('click', doSyncAll);
    document.getElementById('devScan').addEventListener('click', openScan);

    var add = document.getElementById('devAdd');
    if (add) add.addEventListener('click', function () { openForm(null); });

    var box = document.getElementById('devTable');
    box.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      var act = btn.getAttribute('data-act');
      var device = devices.find(function (d) { return d.id === id; });
      if (!device) return;

      if (act === 'test') doTest(device, btn);
      else if (act === 'sync') doSync(device, btn);
      else if (act === 'users') openUsers(device);
      else if (act === 'edit') openForm(device);
      else if (act === 'history') openHistory(device);
      else if (act === 'delete') doDelete(device);
      else if (act === 'clear') doClearLogs(device);
    });

    loadAll();
  };

  function loadAll() {
    var sub = document.getElementById('devSub');
    if (sub) sub.textContent = 'Memuat...';

    api.get('/devices/protocols')
      .then(function (res) { protocols = res.data; })
      .catch(function () { protocols = null; });

    api.get('/devices')
      .then(function (res) {
        devices = res.data || [];
        paint();
        return api.get('/devices/history', { limit: 20 });
      })
      .then(function (res) {
        paintHistory(res.data || []);
      })
      .catch(function (err) {
        document.getElementById('devTable').innerHTML =
          '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paint() {
    var box = document.getElementById('devTable');
    var sub = document.getElementById('devSub');

    var active = devices.filter(function (d) { return Number(d.is_active) === 1; }).length;
    sub.textContent = devices.length + ' perangkat terdaftar, ' + active + ' aktif';

    if (protocols && protocols.push) {
      var alert = document.getElementById('devAlert');
      alert.innerHTML = pushHint(protocols.push);
    }

    var columns = [
      { key: 'name', label: 'Nama', render: function (r) {
        return '<div style="font-weight:500">' + esc(r.name) + '</div>' +
          '<div class="small faint mono">' + esc(r.host || '-') + ':' + esc(r.port) + '</div>';
      } },
      { key: 'protocol', label: 'Protokol', render: function (r) {
        return '<span class="badge info">' + esc(protocolLabel(r.protocol)) + '</span>';
      } },
      { key: 'location', label: 'Lokasi', render: function (r) { return esc(r.location || '-'); } },
      { key: 'is_active', label: 'Status', render: function (r) {
        return Number(r.is_active) === 1
          ? '<span class="badge success">Aktif</span>'
          : '<span class="badge idle">Nonaktif</span>';
      } },
      { key: 'last_sync_at', label: 'Sync Terakhir', render: function (r) {
        if (!r.last_sync_at) return '<span class="faint">belum pernah</span>';
        return '<div class="small nowrap">' + esc(App.fmtRelative(r.last_sync_at)) + '</div>' +
          '<div class="small faint nowrap">' + esc(App.fmtDateTime(r.last_sync_at)) + '</div>';
      } },
      { key: 'last_sync_status', label: 'Hasil', render: function (r) {
        if (!r.last_sync_status) return '<span class="badge idle">-</span>';
        if (r.last_sync_status === 'success') return '<span class="badge success">Berhasil</span>';
        if (r.last_sync_status === 'running') return '<span class="badge running">Proses</span>';
        if (r.last_sync_status === 'disabled') return '<span class="badge idle">Nonaktif</span>';
        return '<span class="badge failed" title="' + escAttr(r.last_sync_message || '') + '">Gagal</span>';
      } },
      { key: 'last_log_count', label: 'Log', align: 'right', render: function (r) {
        var v = r.last_log_count;
        return v === null || v === undefined ? '<span class="faint">-</span>' : App.formatNumber(v);
      } },
      { key: 'aksi', label: 'Aksi', width: '260px', render: function (r) {
        return '<div class="btn-group">' +
          (App.can('devices:sync') ? '<button class="btn sm" data-act="test" data-id="' + r.id + '">Uji</button>' : '') +
          (App.can('devices:sync') ? '<button class="btn sm primary" data-act="sync" data-id="' + r.id + '">Sync</button>' : '') +
          (App.can('devices:sync') ? '<button class="btn sm" data-act="users" data-id="' + r.id + '">User</button>' : '') +
          (App.can('devices:write') ? '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' : '') +
          (App.can('devices:write') ? '<button class="btn sm" data-act="history" data-id="' + r.id + '">Riwayat</button>' : '') +
          (App.can('devices:write') ? '<button class="btn sm danger" data-act="delete" data-id="' + r.id + '">Hapus</button>' : '') +
        '</div>';
      } },
    ];

    box.innerHTML = App.table(columns, devices, {
      empty: 'Belum ada mesin fingerprint terdaftar. Tambahkan perangkat atau pindai jaringan terlebih dahulu.',
      emptyIcon: '&#128421;',
    });

    // Tombol hapus log mesin ditampilkan terpisah agar tidak mudah diklik.
    box.querySelectorAll('tr').forEach(function (tr, i) {
      var device = devices[i];
      if (!device || device.protocol === 'csv') return;
      if (!App.can('devices:write')) return;
      var cell = tr.querySelector('td:last-child .btn-group');
      if (!cell) return;
      var extra = document.createElement('button');
      extra.className = 'btn sm danger';
      extra.setAttribute('data-act', 'clear');
      extra.setAttribute('data-id', String(device.id));
      extra.textContent = 'Hapus Log Mesin';
      extra.title = 'Menghapus semua log di dalam mesin (berbahaya)';
      cell.appendChild(extra);
    });
  }

  function escAttr(v) {
    return esc(v);
  }

  function paintHistory(rows) {
    var box = document.getElementById('devHistory');
    var columns = [
      { key: 'started_at', label: 'Waktu', render: function (r) {
        return '<div class="nowrap small">' + esc(App.fmtDateTime(r.started_at)) + '</div>';
      } },
      { key: 'device_name', label: 'Mesin' },
      { key: 'source', label: 'Sumber', render: function (r) {
        var map = { auto: 'Otomatis', manual: 'Manual', push: 'PUSH' };
        return '<span class="small faint">' + esc(map[r.source] || r.source) + '</span>';
      } },
      { key: 'status', label: 'Status', render: function (r) {
        var s = r.status || 'running';
        var cls = s === 'success' ? 'success' : (s === 'running' ? 'running' : 'failed');
        return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
      } },
      { key: 'record_count', label: 'Log Dibaca', align: 'right', render: function (r) { return App.formatNumber(r.record_count); } },
      { key: 'inserted_count', label: 'Baru', align: 'right', render: function (r) { return App.formatNumber(r.inserted_count); } },
      { key: 'duplicated_count', label: 'Duplikat', align: 'right', render: function (r) { return App.formatNumber(r.duplicated_count); } },
      { key: 'message', label: 'Pesan', render: function (r) {
        return r.message ? '<span class="small muted">' + esc(String(r.message).slice(0, 60)) + '</span>' : '<span class="faint">-</span>';
      } },
    ];

    box.innerHTML = App.table(columns, rows, { empty: 'Belum ada riwayat sinkronisasi.', emptyIcon: '&#128340;' });
  }

  function protocolLabel(key) {
    var map = {
      'zkteco-tcp': 'ZKTeco TCP (4370)',
      'push-http': 'PUSH HTTP (ADMS)',
      'csv': 'Impor File',
    };
    return map[key] || key;
  }

  function pushHint(push) {
    return '<div class="card"><div class="card-body">' +
      '<div class="callout"><strong>Setup mesin mode PUSH / ADMS</strong>' +
      'Pada menu mesin (Comm / ADMS / Cloud Server), isi:<br>' +
      'Server Address: <code>' + esc(push.server_address_hint) + '</code> &nbsp; ' +
      'Server Port: <code>' + esc(push.port) + '</code><br>' +
      'Pastikan mesin berada di jaringan yang sama dengan server, dan firewall mengizinkan port ' + esc(push.port) + '.' +
      (push.auth_token_required ? ' Token autentikasi aktif.' : ' Tanpa autentikasi - Batasi akses jaringan.') +
      '</div>' +
    '</div></div>';
  }

  // ---------------------------------------------------------------- Form

  function openForm(device) {
    var isEdit = Boolean(device);
    var list = (protocols && protocols.protocols) || [];
    var currentProto = isEdit ? device.protocol : 'zkteco-tcp';

    var protoOptions = list.map(function (p) {
      return { key: p.key, label: p.label, hint: p.hint, port: p.default_port, note: p.notes };
    });
    var selected = protoOptions.find(function (p) { return p.key === currentProto; }) || protoOptions[0] || {};

    App.modal({
      title: isEdit ? 'Ubah Perangkat: ' + device.name : 'Tambah Perangkat Fingerprint',
      size: 'wide',
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field">' +
            '<label>Nama Perangkat <span class="req">*</span></label>' +
            '<input type="text" id="dName" value="' + esc(isEdit ? device.name : '') + '" placeholder="mis. Fingerprint Kantor Pusat">' +
          '</div>' +
          '<div class="field">' +
            '<label>Protokol <span class="req">*</span></label>' +
            '<select id="dProto">' +
              protoOptions.map(function (p) {
                return '<option value="' + escAttr(p.key) + '"' + (p.key === currentProto ? ' selected' : '') + '>' + esc(p.label) + '</option>';
              }).join('') +
            '</select>' +
            '<span class="help" id="dProtoHint">' + esc(selected.hint || '') + '</span>' +
          '</div>' +
          '<div class="field">' +
            '<label>Alamat IP / Host <span class="req">*</span></label>' +
            '<input type="text" id="dHost" value="' + esc(isEdit ? device.host || '' : '') + '" placeholder="192.168.1.201">' +
            '<span class="help">Boleh juga hostname, mis. fingerprint.kantor.local</span>' +
          '</div>' +
          '<div class="field">' +
            '<label>Port</label>' +
            '<input type="number" id="dPort" value="' + esc(isEdit ? device.port : (selected.port || 4370)) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label>Lokasi</label>' +
            '<input type="text" id="dLocation" value="' + esc(isEdit ? device.location || '' : '') + '" placeholder="mis. Lantai 1, dekat pintu depan">' +
          '</div>' +
          '<div class="field">' +
            '<label>Password Mesin</label>' +
            '<input type="password" id="dPassword" value="" placeholder="' + (isEdit ? 'Kosongkan bila tidak diubah' : 'Umumnya 0 / kosong') + '">' +
            '<span class="help">Dikirim sebagaiCommunicationPassword saat handshake TCP.</span>' +
          '</div>' +
        '</div>' +

        '<div class="divider"></div>' +
        '<h4 style="margin:0 0 8px">Opsi Lanjutan</h4>' +
        '<div class="form-grid">' +
          '<div class="field checkbox">' +
            '<input type="checkbox" id="dActive"' + (!isEdit || Number(device.is_active) === 1 ? ' checked' : '') + '>' +
            '<label for="dActive">Aktifkan sinkronisasi otomatis</label>' +
          '</div>' +
          '<div class="field checkbox">' +
            '<input type="checkbox" id="dGen"' + (!isEdit || Number(device.auto_regenerate) === 1 ? ' checked' : '') + '>' +
            '<label for="dGen">Hitung ulang rekap setelah sync</label>' +
          '</div>' +
          '<div class="field checkbox">' +
            '<input type="checkbox" id="dClear"' + (isEdit && Number(device.clear_logs_after_sync) === 1 ? ' checked' : '') + '>' +
            '<label for="dClear">Hapus log di mesin setelah sync</label>' +
          '</div>' +
          '<div class="field">' +
            '<label>Regenerasi Rekap (hari)</label>' +
            '<input type="number" id="dRegenDays" value="' + esc(isEdit ? device.regenerate_days : 2) + '" min="0" max="30">' +
            '<span class="help">0 = hanya hari ini, 1 = hari ini + kemarin, 2 = 2 hari ke belakang, dst.</span>' +
          '</div>' +
        '</div>' +
        '<div class="callout warning mt"><strong>Catatan mode PUSH</strong>' +
        'Untuk mode PUSH HTTP, perangkat tidak perlu diisi IP mesin. Mesin akan mengirim log ke server. ' +
        'Isi IP mesin hanya bila ingin tetap bisa melakukan sinkronisasi manual / fallback TCP.</div>',

      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Tambah Perangkat',
          className: 'primary',
          onClick: function (el) {
            var name = el.querySelector('#dName').value.trim();
            var proto = el.querySelector('#dProto').value;
            var host = el.querySelector('#dHost').value.trim();
            var port = Number(el.querySelector('#dPort').value) || 0;

            if (!name) { App.toast('Nama perangkat wajib diisi.', 'error'); return false; }
            if (proto !== 'csv' && !host) { App.toast('Alamat IP / host wajib diisi.', 'error'); return false; }
            if (port < 0 || port > 65535) { App.toast('Port tidak valid.', 'error'); return false; }

            var payload = {
              name: name,
              protocol: proto,
              host: host || null,
              port: port,
              location: el.querySelector('#dLocation').value.trim() || null,
              is_active: el.querySelector('#dActive').checked ? 1 : 0,
              auto_regenerate: el.querySelector('#dGen').checked ? 1 : 0,
              clear_logs_after_sync: el.querySelector('#dClear').checked ? 1 : 0,
              regenerate_days: Number(el.querySelector('#dRegenDays').value) || 0,
            };

            var pwd = el.querySelector('#dPassword').value;
            if (pwd) payload.password = pwd;

            var request = isEdit ? api.put('/devices/' + device.id, payload) : api.post('/devices', payload);
            request
              .then(function () {
                App.toast(isEdit ? 'Perangkat diperbarui.' : 'Perangkat ditambahkan.', 'success');
                el.closeModal();
                loadAll();
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
        el.querySelector('#dProto').addEventListener('change', function () {
          var p = protoOptions.find(function (x) { return x.key === this.value; }, this);
          if (!p) return;
          el.querySelector('#dProtoHint').textContent = p.hint || '';
          if (p.port) el.querySelector('#dPort').value = p.port;
        });
      },
    });
  }

  // ---------------------------------------------------------------- Aksi

  function doTest(device, btn) {
    if (!App.perm('devices:sync')) return;

    btn.disabled = true;
    var old = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';

    api.post('/devices/' + device.id + '/test')
      .then(function (res) {
        var info = res.info || res.data || {};
        App.modal({
          title: 'Hasil Uji Koneksi: ' + device.name,
          bodyHtml:
            '<div class="callout success"><strong>Koneksi berhasil</strong>' +
            'Mesin merespons dalam ' + App.formatNumber(res.elapsed_ms || 0) + ' ms.</div>' +
            App.table([
              { key: 'label', label: 'Informasi' },
              { key: 'value', label: 'Nilai' },
            ], [
              { label: 'Alamat', value: device.host + ':' + device.port },
              { label: 'Protokol', value: protocolLabel(device.protocol) },
              { label: 'Versi Firmware', value: info.firmwareVersion || '-' },
              { label: 'Jumlah User', value: info.users !== undefined ? App.formatNumber(info.users) : '-' },
              { label: 'Jumlah Sidik Jari', value: info.fingers !== undefined ? App.formatNumber(info.fingers) : '-' },
              { label: 'Log Tersimpan', value: info.records !== undefined ? App.formatNumber(info.records) : '-' },
            ], { empty: 'Mesin tidak memberikan informasi tambahan.' }),
          actions: [{ label: 'Tutup' }],
        });
      })
      .catch(function (err) {
        App.modal({
          title: 'Hasil Uji Koneksi: ' + device.name,
          bodyHtml:
            '<div class="callout danger"><strong>Koneksi gagal</strong>' + esc(err.message) + '</div>' +
            '<h4 style="margin:14px 0 8px">Langkah Troubleshooting</h4>' +
            '<ol class="small" style="padding-left:20px;line-height:1.9">' +
              '<li>Pastikan komputer dan mesin berada di jaringan yang sama. Coba <code>ping ' + esc(device.host) + '</code>.</li>' +
              '<li>Buka menu <strong>Comm / Network</strong> pada mesin, pastikan mode <strong>Ethernet</strong> dan IP benar.</li>' +
              '<li>Pastikan port yang diisi sesuai dengan port protokol pada mesin. ZKTeco umumnya 4370.</li>' +
              '<li>Matikan software vendor (mis. ZKTeco Software) yang mungkin sedang memegang koneksi mesin.</li>' +
              '<li>Periksa firewall Windows: izinkan Node.js untuk jaringan privat.</li>' +
              '<li>Jika mesin memakai password, isi password perangkat dengan benar.</li>' +
              '<li>Coba gunakan tool <code>npm run probe -- ' + esc(device.host) + '</code> dari terminal.</li>' +
            '</ol>',
          actions: [{ label: 'Tutup' }],
        });
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  function doSync(device, btn) {
    if (!App.perm('devices:sync')) return;

    btn.disabled = true;
    var old = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Sync';

    api.post('/devices/' + device.id + '/sync', { regenerate_days: 2 })
      .then(function (res) {
        App.toast(
          'Sinkronisasi selesai. ' + App.formatNumber(res.inserted || 0) + ' log baru, ' +
          App.formatNumber(res.duplicated || 0) + ' duplikat, ' + App.formatNumber(res.records || 0) + ' total dibaca.',
          'success'
        );
        loadAll();
      })
      .catch(function (err) {
        App.toast('Sinkronisasi gagal: ' + err.message, 'error');
        loadAll();
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  function doSyncAll() {
    if (!App.perm('devices:sync')) return;

    App.confirm({
      title: 'Sinkronisasi semua mesin',
      heading: 'Tarik log dari ' + devices.length + ' perangkat?',
      message: 'Semua perangkat aktif akan dibaca. Tunggu proses hingga selesai.',
      confirmLabel: 'Mulai Sinkronisasi',
      onConfirm: function () {
        var btn = document.getElementById('devSyncAll');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sync...'; }

        api.post('/devices/sync-all', { regenerate_days: 2 })
          .then(function (res) {
            App.toast(
              'Selesai. ' + App.formatNumber(res.inserted || 0) + ' log baru dari ' +
              App.formatNumber(res.devices || 0) + ' mesin, ' + App.formatNumber(res.failed || 0) + ' gagal.',
              Number(res.failed || 0) > 0 ? 'warning' : 'success'
            );
            loadAll();
          })
          .catch(function (err) { App.toast(err.message, 'error'); })
          .then(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Sinkron Semua'; }
          });
      },
    });
  }

  function doDelete(device) {
    App.confirm({
      title: 'Hapus perangkat',
      heading: 'Hapus ' + device.name + '?',
      message: 'Riwayat log yang sudah tersimpan di database tetap aman. Hanya konfigurasi perangkat yang dihapus.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/devices/' + device.id)
          .then(function (res) {
            App.toast(res.message || 'Perangkat dihapus.', 'success');
            loadAll();
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  function doClearLogs(device) {
    App.confirm({
      title: 'Hapus log di mesin',
      heading: 'Hapus SEMUA log di ' + device.name + '?',
      message: 'Data di dalam mesin akan dih permanen. Log yang sudah tersinkron ke database tetap aman. Tindakan ini tidak bisa dibatalkan.',
      danger: true,
      confirmLabel: 'Hapus Log Mesin',
      onConfirm: function () {
        api.post('/devices/' + device.id + '/clear-logs', { confirm: 'HAPUS LOG MESIN' })
          .then(function (res) {
            App.toast(res.message || 'Log mesin dihapus.', 'success');
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }

  // ---------------------------------------------------------------- Daftar user mesin

  function openUsers(device) {
    if (!App.perm('devices:sync')) return;

    App.modal({
      title: 'User pada Mesin: ' + device.name,
      size: 'wide',
      bodyHtml: '<div id="usersBox">' + App.loading('Membaca daftar user dari mesin...') + '</div>',
      actions: [{ label: 'Tutup' }],
      onMount: function (el) {
        var target = el.querySelector('#usersBox');
        api.get('/devices/' + device.id + '/users')
          .then(function (res) {
            var d = res.data || {};
            var users = d.users || [];

            target.innerHTML =
              '<div class="callout' + (d.unmatched > 0 ? ' warning' : ' success') + '">' +
                '<strong>' + App.formatNumber(d.total) + ' user di mesin</strong>' +
                'Tercocok: ' + App.formatNumber(d.matched) +
                ' | Belum tercocok: ' + App.formatNumber(d.unmatched) +
                (d.unmatched > 0
                  ? '<br>PIN yang belum tercocok tidak akan dihitung sebagai absensi. Tambahkan karyawan dengan PIN yang sama, atau ubah PIN di mesin.'
                  : '') +
              '</div>' +
              App.table([
                { key: 'device_user_id', label: 'PIN Mesin', mono: true },
                { key: 'name_on_device', label: 'Nama di Mesin' },
                { key: 'card_no', label: 'No. Kartu', mono: true },
                { key: 'matched', label: 'Pencocokan', render: function (r) {
                  return r.matched
                    ? '<span class="badge success">' + esc(r.employee.employee_code) + ' - ' + esc(r.employee.name) + '</span>'
                    : '<span class="badge failed">Belum ada karyawan</span>';
                } },
              ], users, { empty: 'Mesin tidak memiliki user.', emptyIcon: '&#128101;' });
          })
          .catch(function (err) {
            target.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
          });
      },
    });
  }

  function openHistory(device) {
    App.modal({
      title: 'Riwayat Sinkronisasi: ' + device.name,
      size: 'wide',
      bodyHtml: '<div id="histBox">' + App.loading('Memuat...') + '</div>',
      actions: [{ label: 'Tutup' }],
      onMount: function (el) {
        var target = el.querySelector('#histBox');
        api.get('/devices/history', { device_id: device.id, limit: 50 })
          .then(function (res) {
            var rows = res.data || [];
            target.innerHTML = App.table([
              { key: 'started_at', label: 'Waktu', render: function (r) { return '<span class="small nowrap">' + esc(App.fmtDateTime(r.started_at)) + '</span>'; } },
              { key: 'status', label: 'Status', render: function (r) {
                var s = r.status || 'running';
                return '<span class="badge ' + (s === 'success' ? 'success' : (s === 'running' ? 'running' : 'failed')) + '">' + esc(s) + '</span>';
              } },
              { key: 'record_count', label: 'Dibaca', align: 'right', render: function (r) { return App.formatNumber(r.record_count); } },
              { key: 'inserted_count', label: 'Baru', align: 'right', render: function (r) { return App.formatNumber(r.inserted_count); } },
              { key: 'duplicated_count', label: 'Duplikat', align: 'right', render: function (r) { return App.formatNumber(r.duplicated_count); } },
              { key: 'message', label: 'Pesan', render: function (r) { return '<span class="small muted">' + esc(r.message || '-') + '</span>'; } },
            ], rows, { empty: 'Belum ada riwayat untuk perangkat ini.' });
          })
          .catch(function (err) {
            target.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
          });
      },
    });
  }

  // ---------------------------------------------------------------- Pindai jaringan

  function openScan() {
    App.modal({
      title: 'Pindai Jaringan',
      size: 'wide',
      bodyHtml:
        '<div class="callout">Pindai seluruh alamat di satu subnet untuk menemukan mesin fingerprint. ' +
        'Pastikan komputer dan mesin berada di jaringan yang sama.</div>' +
        '<div class="form-grid">' +
          '<div class="field">' +
            '<label>Subnet <span class="req">*</span></label>' +
            '<input type="text" id="scanSubnet" value="' + esc(guessSubnet()) + '" placeholder="192.168.1">' +
            '<span class="help">Tanpa octet terakhir, contoh 192.168.1</span>' +
          '</div>' +
          '<div class="field">' +
            '<label>Timeout per port (ms)</label>' +
            '<input type="number" id="scanTimeout" value="600" min="100" max="3000">' +
          '</div>' +
        '</div>' +
        '<div id="scanResult" class="mt"></div>',
      actions: [{ label: 'Tutup' }, { label: 'Mulai Pindai', className: 'primary', onClick: function (el) { runScan(el); return false; } }],
      onMount: function (el) {
        el.querySelector('#scanResult').innerHTML =
          '<div class="callout small">Pindai memeriksa 254 alamat x 6 port. Processo bisa memakan waktu 1-3 menit ' +
          'tergantung jumlah koneksi. Jangan tutup halaman ini.</div>';
      },
    });
  }

  function guessSubnet() {
    // Ambil IP lokal dari halaman (disediakan server lewat window.__LOCAL_IP bila ada).
    if (window.__LOCAL_IP) {
      var parts = String(window.__LOCAL_IP).split('.');
      if (parts.length === 4) return parts.slice(0, 3).join('.');
    }
    return '192.168.1';
  }

  function runScan(el) {
    var subnet = el.querySelector('#scanSubnet').value.trim();
    var timeout = Number(el.querySelector('#scanTimeout').value) || 600;
    var result = el.querySelector('#scanResult');

    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      App.toast('Subnet harus format "192.168.1".', 'error');
      return;
    }

    result.innerHTML = '<div class="loading-row"><span class="spinner"></span> Memindai ' + esc(subnet) + '.0/24 ...</div>';

    api.post('/devices/scan', { subnet: subnet, timeout: timeout })
      .then(function (res) {
        var d = res.data || {};
        var found = d.open_ports || [];
        var identified = d.identified_devices || [];
        var zkOk = identified.filter(function (x) { return x.ok; });

        result.innerHTML =
          '<div class="callout ' + (found.length > 0 ? 'success' : 'warning') + '">' +
            '<strong>' + esc(d.scanned || '') + ' selesai</strong>' + esc(d.hint || '') +
          '</div>' +
          (found.length > 0
            ? App.table([
                { key: 'ip', label: 'IP', mono: true },
                { key: 'port', label: 'Port', mono: true },
                { key: 'note', label: 'Keterangan', render: function (r) {
                  if (r.port === 4370) return '<span class="badge success">ZKTeco TCP - kandidat mesin</span>';
                  if (r.port === 4371) return '<span class="badge info">Port PUSH / ADMS</span>';
                  if (r.port === 80 || r.port === 8080) return '<span class="badge info">Antarmuka web</span>';
                  return '<span class="faint">layanan lain</span>';
                } },
                { key: 'aksi', label: '', render: function (r) {
                  return App.can('devices:write')
                    ? '<button class="btn sm primary" data-add-device="' + escAttr(r.ip) + '" data-port="' + r.port + '">Tambah Perangkat</button>'
                    : '';
                } },
              ], found, { empty: 'Tidak ada port terbuka.' })
            : '') +
          (identified.length > 0
            ? '<h4 style="margin:14px 0 8px">Hasil Identifikasi Protokol</h4>' +
              App.table([
                { key: 'ip', label: 'IP', mono: true },
                { key: 'ok', label: 'Status', render: function (r) {
                  return r.ok
                    ? '<span class="badge success">Mesin ZKTeco</span>'
                    : '<span class="badge failed">Tidak merespons</span>';
                } },
                { key: 'firmware', label: 'Firmware', render: function (r) { return esc(r.firmware || '-'); } },
                { key: 'error', label: 'Error', render: function (r) { return r.error ? '<span class="small muted">' + esc(r.error) + '</span>' : '<span class="faint">-</span>'; } },
              ], identified)
            : '');

        result.querySelectorAll('button[data-add-device]').forEach(function (b) {
          b.addEventListener('click', function () {
            var ip = b.getAttribute('data-add-device');
            var port = Number(b.getAttribute('data-port'));
            var dlg = el.closest('.modal-backdrop');
            if (dlg) dlg.querySelector('[data-close]').click();
            openPrefilledForm(ip, port);
          });
        });
      })
      .catch(function (err) {
        result.innerHTML = '<div class="callout danger"><strong>Pindai gagal</strong>' + esc(err.message) + '</div>';
      });
  }

  function openPrefilledForm(ip, port) {
    if (!App.perm('devices:write')) {
      App.toast('Anda tidak punya hak akses menambah perangkat.', 'error');
      return;
    }
    openForm({ host: ip, port: port, protocol: 'zkteco-tcp', name: 'Fingerprint ' + ip, location: '', is_active: 1, auto_regenerate: 1, clear_logs_after_sync: 0, regenerate_days: 2 });
    App.toast('Lengkapi nama perangkat lalu simpan.', 'info');
  }
})();
