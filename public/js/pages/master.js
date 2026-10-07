/* =============================================================================
 * HALAMAN DATA MASTER - UNIT KERJA (DIVISI/DEPARTEMEN) & JABATAN
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var tab = 'departments';
  var rows = [];

  var TABS = {
    departments: { title: 'Unit Kerja', label: 'Unit Kerja / Divisi', codeLabel: 'Kode Unit', placeholder: 'Contoh: HRD' },
    positions: { title: 'Jabatan', label: 'Jabatan', codeLabel: 'Kode Jabatan', placeholder: 'Contoh: MGR' },
  };

  window.Pages.master = function (root) {
    var cfg = TABS[tab];

    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div class="btn-group">' +
            '<button class="btn ' + (tab === 'departments' ? 'primary' : '') + '" data-tab="departments">Unit Kerja</button>' +
            '<button class="btn ' + (tab === 'positions' ? 'primary' : '') + '" data-tab="positions">Jabatan</button>' +
          '</div>' +
          '<div class="btn-group">' +
            (App.can('master:write') ? '<button class="btn primary" id="mstAdd">+ Tambah ' + esc(cfg.title) + '</button>' : '') +
            '<button class="btn" id="mstReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
        '<p class="card-subtitle">Data master ' + esc(cfg.label.toLowerCase()) +
          ' dipakai sebagai pilihan dropdown pada form karyawan, filter laporan/absensi, dan jadwal massal.</p>' +
      '</div>' +
      '<div id="mstBody"></div>';

    document.querySelectorAll('#pageContent [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        tab = b.getAttribute('data-tab');
        window.Pages.master(root);
      });
    });

    document.getElementById('mstReload').addEventListener('click', load);
    var add = document.getElementById('mstAdd');
    if (add) add.addEventListener('click', function () { openForm(null); });

    load();
  };

  function load() {
    var box = document.getElementById('mstBody');
    box.innerHTML = App.loading('Memuat data master...');

    api.get('/master/' + tab)
      .then(function (res) {
        rows = res.data || [];
        paintList();
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>' + esc(err.message) + '</div></div>';
      });
  }

  function paintList() {
    var box = document.getElementById('mstBody');
    var cfg = TABS[tab];

    var columns = [
      { key: 'code', label: cfg.codeLabel, mono: true },
      { key: 'name', label: cfg.label },
      { key: 'usage', label: 'Dipakai Karyawan', align: 'right', render: function (r) {
        return r.usage + ' karyawan';
      } },
      { key: 'aksi', label: 'Aksi', width: '150px', render: function (r) {
        if (!App.can('master:write')) return '';
        return '<div class="btn-group">' +
          '<button class="btn sm" data-act="edit" data-id="' + r.id + '">Ubah</button>' +
          '<button class="btn sm danger" data-act="delete" data-id="' + r.id + '">Hapus</button>' +
        '</div>';
      } },
    ];

    box.innerHTML = '<div class="card"><div class="card-body tight">' + App.table(columns, rows, {
      empty: 'Belum ada ' + esc(cfg.label.toLowerCase()) + '. Tambahkan minimal satu.',
      emptyIcon: '&#128203;',
    }) + '</div></div>';

    box.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-id'));
        var act = b.getAttribute('data-act');
        var row = rows.find(function (r) { return r.id === id; });
        if (act === 'edit') openForm(row);
        else if (act === 'delete') doDelete(row);
      });
    });
  }

  // ---------------------------------------------------------------- Form

  function openForm(row) {
    var isEdit = Boolean(row);
    var cfg = TABS[tab];

    App.modal({
      title: (isEdit ? 'Ubah ' : 'Tambah ') + cfg.title,
      bodyHtml:
        '<div class="form-grid">' +
          '<div class="field"><label>' + esc(cfg.codeLabel) + ' <span class="req">*</span></label>' +
            '<input type="text" id="mstCode" value="' + esc(isEdit ? row.code : '') + '" placeholder="' + esc(cfg.placeholder) + '" ' + (isEdit ? 'disabled' : '') + '>' +
            (isEdit ? '<span class="help">Kode tidak dapat diubah setelah dibuat.</span>' : '') +
          '</div>' +
          '<div class="field"><label>Nama ' + esc(cfg.title) + ' <span class="req">*</span></label>' +
            '<input type="text" id="mstName" value="' + esc(isEdit ? row.name : '') + '" placeholder="Contoh: ' + (tab === 'departments' ? 'Human Resource' : 'Manajer') + '"></div>' +
        '</div>',

      actions: [
        { label: 'Batal' },
        {
          label: isEdit ? 'Simpan Perubahan' : 'Simpan',
          className: 'primary',
          onClick: function (el) {
            var code = el.querySelector('#mstCode').value.trim() || (isEdit ? row.code : '');
            var name = el.querySelector('#mstName').value.trim();

            if (!code) { App.toast(cfg.codeLabel + ' wajib diisi.', 'error'); return false; }
            if (!name) { App.toast('Nama wajib diisi.', 'error'); return false; }

            var payload = isEdit ? { name: name } : { code: code, name: name };
            var request = isEdit
              ? api.put('/master/' + tab + '/' + row.id, payload)
              : api.post('/master/' + tab, payload);

            request
              .then(function () {
                App.toast(isEdit ? 'Data diperbarui.' : 'Data ditambahkan.', 'success');
                el.closeModal();
                load();
                // Dropdown di form karyawan membaca /auth/meta, jadi segarkan
                // supaya pilihan baru langsung muncul tanpa logout.
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

  function doDelete(row) {
    var cfg = TABS[tab];

    App.confirm({
      title: 'Hapus ' + cfg.title,
      heading: 'Hapus ' + esc(row.name) + '?',
      message: row.usage > 0
        ? 'Data ini masih dipakai oleh ' + row.usage + ' karyawan sehingga tidak bisa dihapus. Kosongkan dulu unit kerja/jabatan pada karyawan terkait.'
        : 'Data master yang sudah dihapus tidak dapat dikembalikan.',
      danger: true,
      confirmLabel: 'Ya, Hapus',
      onConfirm: function () {
        api.del('/master/' + tab + '/' + row.id)
          .then(function () {
            App.toast('Data dihapus.', 'success');
            load();
            api.get('/auth/meta').then(function (res) { App.state.meta = res.data; }).catch(function () {});
          })
          .catch(function (err) { App.toast(err.message, 'error'); });
      },
    });
  }
})();
