/* =============================================================================
 * Halaman NOTIFIKASI (riwayat inbox realtime)
 *
 * Bell hanya menampilkan yang belum dibaca. Semua notifikasi, termasuk yang
 * sudah dibaca, bisa dilihat di sini dengan pagination.
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  window.Pages = window.Pages || {};

  var page = 1;
  var perPage = 20;
  var unreadOnly = false;

  window.Pages.notifications = function (root) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-header">' +
          '<div><h2 class="card-title">Notifikasi</h2>' +
          '<p class="card-subtitle">Riwayat pengajuan dinas &amp; reimburse</p></div>' +
          '<div class="btn-group">' +
            '<button class="btn sm" data-filter="all">Semua</button>' +
            '<button class="btn sm" data-filter="unread">Belum dibaca</button>' +
            '<button class="btn sm" id="notifReadAll">Tandai semua dibaca</button>' +
            '<button class="btn sm" id="notifReload">&#8635; Muat Ulang</button>' +
          '</div>' +
        '</div>' +
        '<div class="card-body tight" id="notifBody">' + App.loading('Memuat notifikasi...') + '</div>' +
        '<div id="notifPager"></div>' +
      '</div>';

    root.querySelectorAll('[data-filter]').forEach(function (b) {
      if ((b.getAttribute('data-filter') === 'unread') === unreadOnly) b.classList.add('primary');
      b.addEventListener('click', function () {
        unreadOnly = b.getAttribute('data-filter') === 'unread';
        page = 1;
        window.Pages.notifications(root);
      });
    });

    document.getElementById('notifReload').addEventListener('click', load);
    document.getElementById('notifReadAll').addEventListener('click', function () {
      api.post('/notifications/read/all', {})
        .then(function () { load(); })
        .catch(function (err) { App.toast(err.message, 'error'); });
    });

    load();
  };

  function load() {
    var box = document.getElementById('notifBody');
    if (!box) return;
    box.innerHTML = App.loading('Memuat notifikasi...');

    var q = { per_page: perPage, page: page };
    if (unreadOnly) q.unread = '1';

    api.get('/notifications', q)
      .then(function (res) {
        paint(res.data || [], res.meta || {});
      })
      .catch(function (err) {
        box.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div>' +
          '<div>Gagal memuat notifikasi: ' + esc(err.message) + '</div></div>';
      });
  }

  function paint(rows, meta_) {
    var box = document.getElementById('notifBody');
    if (!box) return;

    box.innerHTML = App.table([
      { key: 'created_at', label: 'Waktu', render: function (r) { return esc(App.fmtDateTime(r.created_at)); } },
      { key: 'title', label: 'Judul', render: function (r) {
        return '<div style="font-weight:600">' + esc(r.title) + '</div>' +
          (r.body ? '<div class="small faint">' + esc(r.body) + '</div>' : '');
      } },
      { key: 'is_read', label: 'Status', render: function (r) {
        return Number(r.is_read)
          ? '<span class="badge idle">Dibaca</span>'
          : '<span class="badge info">Baru</span>';
      } },
      { key: 'aksi', label: '', width: '130px', render: function (r) {
        return Number(r.is_read) ? '' :
          '<button class="btn sm" data-read="' + r.id + '">Tandai dibaca</button>';
      } },
    ], rows, { empty: 'Belum ada notifikasi.', emptyIcon: '&#128276;' });

    box.querySelectorAll('[data-read]').forEach(function (b) {
      b.addEventListener('click', function () {
        api.post('/notifications/read/' + b.getAttribute('data-read'), {})
          .then(function () { load(); })
          .catch(function (err) { App.toast(err.message, 'error'); });
      });
    });

    var pager = document.getElementById('notifPager');
    if (!pager) return;
    if ((meta_.total_pages || 0) > 1) {
      pager.innerHTML = '<div class="pagination">' +
        '<span>' + App.formatNumber(meta_.total || 0) + ' notifikasi | Halaman ' + meta_.page + ' dari ' + meta_.total_pages + '</span>' +
        '<button class="btn sm" data-pg="prev"' + (meta_.page <= 1 ? ' disabled' : '') + '>&laquo; Sebelumnya</button>' +
        '<button class="btn sm" data-pg="next"' + (meta_.page >= meta_.total_pages ? ' disabled' : '') + '>Berikutnya &raquo;</button>' +
      '</div>';
      pager.querySelectorAll('button[data-pg]').forEach(function (b) {
        b.addEventListener('click', function () {
          page = b.getAttribute('data-pg') === 'next' ? meta_.page + 1 : meta_.page - 1;
          load();
        });
      });
    } else {
      pager.innerHTML = '';
    }
  }
})();
