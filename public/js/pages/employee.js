/* =============================================================================
 * PORTAL KARYAWAN - Profil, rekap kehadiran, pengajuan, dinas luar kota
 * ========================================================================== */

(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var esc = App.esc;

  var LEAVE_CATALOG = [
    {
      key: 'cuti',
      label: 'Cuti',
      subtypes: [
        { key: 'cuti_tahunan', label: 'Cuti Tahunan' },
        { key: 'cuti_sakit', label: 'Cuti Sakit' },
        { key: 'cuti_melahirkan', label: 'Cuti Melahirkan' },
        { key: 'cuti_menikah', label: 'Cuti Menikah' },
        { key: 'cuti_haji', label: 'Cuti Haji / Umrah' },
        { key: 'cuti_kematian_keluarga', label: 'Cuti Kematian Keluarga' },
        { key: 'cuti_alasan_penting', label: 'Cuti Alasan Penting' },
        { key: 'cuti_tanpa_bayar', label: 'Cuti Tanpa Bayar' },
        { key: 'cuti_lainnya', label: 'Cuti Lainnya' },
      ],
    },
    {
      key: 'izin',
      label: 'Izin',
      subtypes: [
        { key: 'izin_tidak_masuk', label: 'Izin Tidak Masuk' },
        { key: 'izin_terlambat', label: 'Izin Terlambat' },
        { key: 'izin_pulang_cepat', label: 'Izin Pulang Cepat' },
        { key: 'izin_kebutuhan_pribadi', label: 'Izin Keperluan Pribadi' },
        { key: 'izin_keluarga', label: 'Izin Mengurus Keluarga' },
        { key: 'izin_administrasi', label: 'Izin Mengurus Administrasi / Dokumen' },
        { key: 'izin_sakit', label: 'Izin Sakit' },
        { key: 'izin_meninggal', label: 'Izin Kematian Keluarga' },
        { key: 'izin_lainnya', label: 'Izin Lainnya' },
      ],
    },
    {
      key: 'dinas',
      label: 'Dinas',
      subtypes: [
        { key: 'dinas_dalam_kota', label: 'Dinas Dalam Kota', single_day: true },
        { key: 'dinas_luar_kota', label: 'Dinas Luar Kota', single_day: false },
      ],
    },
  ];

  window.Pages = window.Pages || {};

  // ------------------------------------------------------------------ GPS

  /**
   * Ambil koordinat sekali dari GPS perangkat.
   * Pesan error dibuat spesifik karena izin lokasi sering ditolak tanpa
   * penjelasan, terutama saat aplikasi dibuka lewat IP (non-HTTPS).
   */
  function getCoordinates() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('Perangkat Anda tidak mendukung pengambilan lokasi (GPS).'));
        return;
      }
      if (window.isSecureContext === false) {
        reject(
          new Error(
            'Lokasi hanya bisa diambil pada koneksi HTTPS. Hubungi admin untuk mengaktifkan HTTPS.'
          )
        );
        return;
      }

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        function (err) {
          var messages = {
            1: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini lalu coba lagi.',
            2: 'Lokasi tidak ditemukan. Pastikan GPS perangkat dalam keadaan aktif.',
            3: 'Waktu pencarian lokasi habis. Coba lagi di tempat dengan sinyal GPS.',
          };
          reject(new Error(messages[err.code] || 'Gagal mengambil lokasi: ' + err.message));
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
      );
    });
  }

  function accuracyLabel(meters) {
    if (meters === null || meters === undefined || meters === '') return '';
    return ' &plusmn;' + Math.round(Number(meters)) + ' m';
  }

  function clockOf(value) {
    if (!value) return null;
    var s = String(value);
    return s.length >= 16 ? s.slice(11, 16) : s;
  }

  // ------------------------------------------------------------------ Render

  function render(el) {
    el.innerHTML =
      '<div class="grid-2">' +
        '<div id="empProfileCard" class="card"><div class="card-body">' +
          App.loading('Memuat profil...') +
        '</div></div>' +
        '<div id="empTodayCard" class="card"><div class="card-body">' +
          App.loading('Memuat status hari ini...') +
        '</div></div>' +
      '</div>' +
      '<div id="empDutyCard" class="card"></div>' +
      '<div id="empLeaveCard" class="card"></div>' +
      '<div id="empRecapCard" class="card"></div>';

    loadProfile();
    loadToday();
    loadDuty();
    loadLeaves();
    loadRecap();
  }

  // ------------------------------------------------------------------ Profil

  function loadProfile() {
    var el = document.getElementById('empProfileCard');
    if (!el) return;

    api
      .get('/me/profile')
      .then(function (res) {
        var d = res.data;
        var e = d.employee;
        var quota = d.leave_quota || null;

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Profil Saya</h2>' +
            '<span class="badge ' + (e.status === 'aktif' ? 'hadir' : 'belum') + '">' +
              esc(e.status) + '</span>' +
          '</div>' +
          '<div class="card-body">' +
            '<div class="grid-2">' +
              kv('Kode Karyawan', e.employee_code) +
              kv('Nama', e.name) +
              kv('Departemen', e.department_name) +
              kv('Jabatan', e.position_name) +
              kv('No. HP', e.phone) +
              kv('Email', e.email) +
              kv('Alamat', e.address) +
            '</div>' +
          '</div>' +
          (quota && quota.quota > 0 ? quotaCard(quota) : '');
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat profil', err);
      });
  }

  /** Kartu sisa jatah cuti tahunan untuk karyawan. */
  function quotaCard(quota) {
    var remaining = Number(quota.remaining || 0);
    var badge = remaining <= 0
      ? '<span class="badge failed">Jatah habis</span>'
      : remaining <= 2
        ? '<span class="badge warning">Sisa ' + remaining + ' hari</span>'
        : '<span class="badge success">Sisa ' + remaining + ' hari</span>';

    return (
      '<div class="card-body" style="border-top:1px solid var(--border)">' +
        '<div class="stat-grid">' +
          statBox('Jatah Cuti Tahunan', quota.quota + ' hari') +
          statBox('Sudah Dipakai', quota.used + ' hari') +
          statBox('Sisa Jatah', badge) +
        '</div>' +
        (quota.reset_at
          ? '<div class="help">Jatah terakhir dikembalikan penuh pada ' +
            esc(App.fmtDateTime(quota.reset_at)) + '.</div>'
          : '') +
      '</div>'
    );
  }

  function kv(label, value) {
    return (
      '<div>' +
        '<div class="stat-label">' + esc(label) + '</div>' +
        '<div style="font-weight:600">' + (value ? esc(value) : '-') + '</div>' +
      '</div>'
    );
  }

  // ------------------------------------------------------------------ Hari ini

  function loadToday() {
    var el = document.getElementById('empTodayCard');
    if (!el) return;

    api
      .get('/me/today')
      .then(function (res) {
        var d = res.data;
        var daily = d.daily;
        var body;

        if (daily) {
          body =
            '<div class="stat-grid">' +
              statBox('Status', App.badge(daily.status)) +
              statBox('Jam Masuk', daily.jam_masuk || '-') +
              statBox('Jam Kerja', daily.jam_kerja + ' jam') +
              statBox('Lembur', daily.jam_lembur + ' jam') +
            '</div>' +
            (daily.note ? '<div class="callout">' + esc(daily.note) + '</div>' : '');
        } else {
          body = '<div class="empty-state">Rekap hari ini belum tersedia.</div>';
        }

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Hari Ini</h2>' +
            '<span class="small faint">' + esc(d.work_date) + '</span>' +
          '</div>' +
          '<div class="card-body">' + body + '</div>';
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat status hari ini', err);
      });
  }

  function statBox(label, valueHtml) {
    return (
      '<div class="stat">' +
        '<div class="stat-label">' + esc(label) + '</div>' +
        '<div class="stat-value">' + valueHtml + '</div>' +
      '</div>'
    );
  }

  // -------------------------------------------------------- Dinas luar kota

  function loadDuty() {
    var el = document.getElementById('empDutyCard');
    if (!el) return;

    Promise.all([api.get('/me/today'), api.get('/me/duty-checkins', { limit: 20 })])
      .then(function (results) {
        var today = results[0].data;
        var history = results[1].data || [];
        var loc = today.duty;

        var bodyHtml;
        if (loc) {
          bodyHtml =
            '<div class="callout success"><strong>Sudah check-in dinas luar kota</strong>' +
              'Check-in ' + esc(clockOf(loc.check_in_at) || '-') + ' di ' +
              esc(Number(loc.latitude).toFixed(6)) + ', ' +
              esc(Number(loc.longitude).toFixed(6)) + accuracyLabel(loc.accuracy_m) + '.' +
              (loc.check_out_at
                ? ' Check-out ' + esc(clockOf(loc.check_out_at) || '-') + '.'
                : ' Belum check-out.') +
            '</div>' +
            (loc.check_out_at
              ? ''
              : '<button class="btn primary" id="btnDutyCheckout">Check-out Dinas Luar</button>');
        } else {
          bodyHtml =
            '<div class="callout ' + (today.can_check_in ? 'success' : 'warning') + '">' +
              esc(today.check_in_blocked_reason || '') +
            '</div>' +
            (today.can_check_in ? dutyFormHtml(today) : '');
        }

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Dinas Luar Kota</h2>' +
            (today.approved_duty_leave
              ? '<span class="badge dinas_luar">Disetujui ' +
                esc(today.approved_duty_leave.start_date) + ' s/d ' +
                esc(today.approved_duty_leave.end_date) + '</span>'
              : '<span class="badge belum">Belum ada persetujuan</span>') +
          '</div>' +
          '<div class="card-body">' + bodyHtml + '</div>' +
          '<div class="card-body tight">' + dutyHistoryTable(history) + '</div>';

        bindDutyForm(el, today);
        bindDutyCheckout();
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat data dinas luar kota', err);
      });
  }

  function dutyFormHtml(today) {
    return (
      '<div class="callout">' +
        'Check-in dinas luar kota wajib menyertakan lokasi GPS dan foto selfie. ' +
        'Jam dicatat dari server, bukan dari jam perangkat.' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="field">' +
          '<label>Keterangan (opsional)</label>' +
          '<input type="text" id="dutyNote" maxlength="500" placeholder="Contoh: Meeting Antimunisi Surabaya">' +
        '</div>' +
        '<div class="field">' +
          '<label>Foto Selfie <span class="req">*</span></label>' +
          '<input type="file" id="dutySelfie" accept="image/jpeg,image/png,image/webp" capture="user" required>' +
          '<span class="help">JPG/PNG/WEBP, maksimal 5 MB.</span>' +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<label>Lokasi GPS <span class="req">*</span></label>' +
        '<button type="button" class="btn" id="btnGetLocation">Ambil Lokasi Saya</button>' +
        '<span class="help" id="dutyLocText">Belum diambil.</span>' +
      '</div>' +
      '<button class="btn primary" id="btnDutyCheckin">Kirim Check-in (' + esc(today.work_date) + ')</button>'
    );
  }

  function bindDutyForm(el, today) {
    var getBtn = document.getElementById('btnGetLocation');
    var submitBtn = document.getElementById('btnDutyCheckin');
    if (!getBtn || !submitBtn) return;

    var coords = null;
    var locText = document.getElementById('dutyLocText');

    getBtn.addEventListener('click', function () {
      getBtn.disabled = true;
      getBtn.innerHTML = '<span class="spinner"></span> Mengambil lokasi...';
      locText.textContent = 'Meminta izin lokasi...';

      getCoordinates()
        .then(function (result) {
          coords = result;
          locText.innerHTML =
            '<strong>' + esc(result.latitude.toFixed(6)) + ', ' + esc(result.longitude.toFixed(6)) +
            '</strong>' + accuracyLabel(result.accuracy) + ' &middot; lokasi valid';
          App.toast('Lokasi berhasil diambil.', 'success');
        })
        .catch(function (err) {
          coords = null;
          locText.innerHTML = '<strong>' + esc(err.message) + '</strong>';
          App.toast(err.message, 'error');
        })
        .then(function () {
          getBtn.disabled = false;
          getBtn.textContent = 'Ambil Lokasi Saya';
        });
    });

    submitBtn.addEventListener('click', function () {
      var fileInput = document.getElementById('dutySelfie');
      var file = fileInput.files && fileInput.files[0];

      if (!coords) {
        App.toast('Ambil lokasi GPS terlebih dahulu.', 'error');
        return;
      }
      if (!file) {
        App.toast('Foto selfie wajib diunggah.', 'error');
        return;
      }

      var fd = new FormData();
      fd.append('work_date', today.work_date);
      fd.append('latitude', String(coords.latitude));
      fd.append('longitude', String(coords.longitude));
      fd.append('accuracy', String(coords.accuracy));
      fd.append('note', document.getElementById('dutyNote').value.trim());
      fd.append('selfie', file, file.name);

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span> Mengirim...';

      api
        .upload('/me/duty-checkins', fd)
        .then(function () {
          App.toast('Check-in dinas luar kota berhasil dicatat.', 'success');
          loadToday();
          loadDuty();
          loadRecap();
        })
        .catch(function (err) {
          App.toast(err.message, 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Kirim Check-in';
        });
    });
  }

  function bindDutyCheckout() {
    var btn = document.getElementById('btnDutyCheckout');
    if (!btn) return;

    btn.addEventListener('click', function () {
      btn.disabled = true;
      api
        .post('/me/duty-checkins/check-out', {})
        .then(function () {
          App.toast('Check-out dinas luar kota dicatat.', 'success');
          loadToday();
          loadDuty();
          loadRecap();
        })
        .catch(function (err) {
          App.toast(err.message, 'error');
          btn.disabled = false;
        });
    });
  }

  function dutyHistoryTable(rows) {
    var columns = [
      { key: 'work_date', label: 'Tanggal' },
      { key: 'jam_masuk', label: 'Check-in' },
      { key: 'jam_keluar', label: 'Check-out' },
      {
        key: 'koordinat',
        label: 'Koordinat',
        mono: true,
        render: function (r) {
          return (
            esc(Number(r.latitude).toFixed(6)) +
            ', ' +
            esc(Number(r.longitude).toFixed(6)) +
            accuracyLabel(r.accuracy_m)
          );
        },
      },
      { key: 'address', label: 'Alamat' },
      { key: 'note', label: 'Keterangan' },
      {
        key: 'selfie_url',
        label: 'Selfie',
        align: 'right',
        render: function (r) {
          return '<button class="btn sm" data-selfie="' + esc(r.selfie_url) + '">Lihat</button>';
        },
      },
    ];

    var html = App.table(columns, rows, {
      empty: 'Belum ada riwayat dinas luar kota.',
      emptyIcon: '&#128188;',
    });

    if (rows.length >= 20) {
      html += '<div class="card-body"><div class="small faint">20 data terakhir ditampilkan.</div></div>';
    }

    // Delegasi event setelah tabel masuk DOM.
    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-selfie]'), function (btn) {
        btn.addEventListener('click', function () {
          openSelfie(btn.getAttribute('data-selfie'));
        });
      });
    }, 0);

    return html;
  }

  /** Selfie dilindungi token, jadi diambil lewat fetch lalu ditampilkan di modal. */
  function openSelfie(url) {
    fetch(url, { headers: { Authorization: 'Bearer ' + api.token } })
      .then(function (res) {
        if (!res.ok) throw new Error('Foto tidak dapat dimuat (' + res.status + ').');
        return res.blob();
      })
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);
        App.modal({
          title: 'Foto Selfie Dinas Luar Kota',
          bodyHtml:
            '<img src="' + objectUrl + '" alt="Selfie dinas luar kota" style="width:100%;border-radius:8px">',
          actions: [{ label: 'Tutup' }],
          onClose: function () {
            URL.revokeObjectURL(objectUrl);
          },
        });
      })
      .catch(function (err) {
        App.toast(err.message, 'error');
      });
  }

  // --------------------------------------------------------- Pengajuan izin

  function loadLeaves() {
    api
      .get('/me/leaves', { limit: 50 })
      .then(function (res) {
        var rows = res.data || [];
        var el = document.getElementById('empLeaveCard');
        if (!el) return;

        var columns = [
          {
            key: 'category',
            label: 'Kategori',
            render: function (r) {
              var catLabel = r.category
                ? (r.category === 'cuti' ? 'Cuti' : r.category === 'izin' ? 'Izin' : 'Dinas')
                : '-';
              return '<span class="badge izin">' + esc(catLabel) + '</span>';
            },
          },
          {
            key: 'subtype_label',
            label: 'Jenis',
            render: function (r) {
              return esc(r.subtype_label || r.leave_type || '-');
            },
          },
          { key: 'start_date', label: 'Mulai' },
          { key: 'end_date', label: 'Selesai' },
          { key: 'reason', label: 'Keterangan' },
          {
            key: 'status',
            label: 'Status',
            render: function (r) {
              var cls = r.status === 'approved' ? 'hadir' : r.status === 'rejected' ? 'alpa' : 'telat';
              return (
                '<span class="badge ' + cls + '">' +
                esc(App.LEAVE_STATUS_LABELS[r.status] || r.status) +
                '</span>'
              );
            },
          },
          { key: 'review_note', label: 'Catatan' },
          {
            key: 'aksi',
            label: '',
            align: 'right',
            render: function (r) {
              return r.status === 'pending'
                ? '<button class="btn sm danger" data-cancel="' + esc(r.id) + '">Batalkan</button>'
                : '';
            },
          },
        ];

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Pengajuan Izin / Cuti / Dinas</h2>' +
            '<button class="btn primary sm" id="btnNewLeave">+ Pengajuan Baru</button>' +
          '</div>' +
          '<div class="card-body tight">' +
            App.table(columns, rows, { empty: 'Belum ada pengajuan.' }) +
          '</div>';

        document.getElementById('btnNewLeave').addEventListener('click', openLeaveForm);

        Array.prototype.forEach.call(document.querySelectorAll('[data-cancel]'), function (btn) {
          btn.addEventListener('click', function () {
            confirmCancelLeave(btn.getAttribute('data-cancel'));
          });
        });
      })
      .catch(function (err) {
        var el = document.getElementById('empLeaveCard');
        if (el) el.innerHTML = errorBlock('Gagal memuat pengajuan', err);
      });
  }

  function confirmCancelLeave(id) {
    App.confirm({
      title: 'Batalkan pengajuan',
      heading: 'Batalkan pengajuan ini?',
      message: 'Pengajuan yang masih menunggu akan ditandai ditolak.',
      confirmLabel: 'Ya, Batalkan',
      onConfirm: function () {
        api
          .del('/me/leaves/' + id)
          .then(function () {
            App.toast('Pengajuan dibatalkan.', 'success');
            loadLeaves();
            loadToday();
          })
          .catch(function (err) {
            App.toast(err.message, 'error');
          });
      },
    });
  }

  function openLeaveForm() {
    var categoryOptions = LEAVE_CATALOG.map(function (c) {
      return '<option value="' + esc(c.key) + '">' + esc(c.label) + '</option>';
    }).join('');

    App.modal({
      title: 'Pengajuan Izin / Cuti / Dinas',
      bodyHtml:
        '<div class="field"><label>Kategori Pengajuan <span class="req">*</span></label>' +
          '<select id="lfCategory">' + categoryOptions + '</select></div>' +
        '<div class="field" id="lfSubtypeWrap"><label>Jenis <span class="req">*</span></label>' +
          '<select id="lfSubtype"></select></div>' +
        '<div class="field" id="lfPlaceWrap" style="display:none"><label>Tujuan / Lokasi <span class="req">*</span></label>' +
          '<input type="text" id="lfPlace" maxlength="150" placeholder="Contoh: Kantor cabang Surabaya"></div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Tanggal Mulai <span class="req">*</span></label>' +
            '<input type="date" id="lfStart" value="' + esc(App.today()) + '"></div>' +
          '<div class="field" id="lfEndWrap"><label>Tanggal Selesai <span class="req">*</span></label>' +
            '<input type="date" id="lfEnd" value="' + esc(App.today()) + '">' +
            '<span class="help">Kosongkan bila hanya satu hari.</span></div>' +
        '</div>' +
        '<div class="field"><label>Keterangan / Alasan <span class="req">*</span></label>' +
          '<textarea id="lfReason" rows="3" maxlength="500" ' +
            'placeholder="Jelaskan keterangan pengajuan"></textarea></div>' +
        '<div class="callout">Pengajuan diteruskan ke admin/HR untuk persetujuan. ' +
          'Check-in GPS + selfie untuk dinas luar kota baru bisa dilakukan setelah disetujui.</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Kirim Pengajuan',
          className: 'primary',
          onClick: function (el) {
            var category = el.querySelector('#lfCategory').value;
            var subtype = el.querySelector('#lfSubtype').value;
            var start = el.querySelector('#lfStart').value;
            var end = el.querySelector('#lfEnd').value || start;
            var reason = el.querySelector('#lfReason').value.trim();
            var place = el.querySelector('#lfPlace').value.trim();

            if (!start) {
              App.toast('Tanggal mulai wajib diisi.', 'error');
              return false;
            }
            if (!reason) {
              App.toast('Keterangan wajib diisi.', 'error');
              return false;
            }

            var payload = {
              category: category,
              subtype: subtype,
              start_date: start,
              end_date: end,
              reason: reason,
            };
            if (place) payload.place = place;

            api
              .post('/me/leaves', payload)
              .then(function () {
                App.toast('Pengajuan terkirim, menunggu persetujuan.', 'success');
                el.closeModal();
                loadLeaves();
                loadToday();
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

    bindLeaveForm();
  }

  function bindLeaveForm() {
    var categorySelect = document.getElementById('lfCategory');
    var subtypeSelect = document.getElementById('lfSubtype');
    var subtypeWrap = document.getElementById('lfSubtypeWrap');
    var placeWrap = document.getElementById('lfPlaceWrap');
    var endWrap = document.getElementById('lfEndWrap');
    if (!categorySelect || !subtypeSelect) return;

    function updateForm() {
      var catKey = categorySelect.value;
      var cat = null;
      for (var i = 0; i < LEAVE_CATALOG.length; i++) {
        if (LEAVE_CATALOG[i].key === catKey) { cat = LEAVE_CATALOG[i]; break; }
      }
      if (!cat) {
        subtypeWrap.style.display = 'none';
        placeWrap.style.display = 'none';
        endWrap.style.display = '';
        return;
      }

      subtypeWrap.style.display = '';
      subtypeSelect.innerHTML = cat.subtypes.map(function (s) {
        return '<option value="' + esc(s.key) + '">' + esc(s.label) + '</option>';
      }).join('');

      var sub = cat.subtypes[0];
      var isDinas = catKey === 'dinas';
      var isSingleDay = sub && sub.single_day;

      placeWrap.style.display = isDinas ? '' : 'none';
      endWrap.style.display = isSingleDay ? 'none' : '';
    }

    categorySelect.addEventListener('change', updateForm);
    subtypeSelect.addEventListener('change', function () {
      var catKey = categorySelect.value;
      var cat = null;
      for (var i = 0; i < LEAVE_CATALOG.length; i++) {
        if (LEAVE_CATALOG[i].key === catKey) { cat = LEAVE_CATALOG[i]; break; }
      }
      if (!cat) return;
      var sub = null;
      for (var j = 0; j < cat.subtypes.length; j++) {
        if (cat.subtypes[j].key === subtypeSelect.value) { sub = cat.subtypes[j]; break; }
      }
      if (!sub) return;
      var isDinas = catKey === 'dinas';
      var isSingleDay = sub.single_day;
      placeWrap.style.display = isDinas ? '' : 'none';
      endWrap.style.display = isSingleDay ? 'none' : '';
    });

    updateForm();
  }

  // --------------------------------------------------------- Rekap kehadiran

  function loadRecap() {
    var el = document.getElementById('empRecapCard');
    if (!el) return;

    api
      .get('/me/attendance', { per_page: 31 })
      .then(function (res) {
        var d = res.data;
        var columns = [
          { key: 'tanggal', label: 'Tanggal' },
          { key: 'jam_masuk', label: 'Jam Masuk' },
          { key: 'jam_keluar', label: 'Jam Keluar' },
          { key: 'jam_kerja', label: 'Jam Kerja', align: 'right' },
          {
            key: 'late_minutes',
            label: 'Telat',
            align: 'right',
            render: function (r) {
              return r.late_minutes ? esc(App.fmtMinutes(r.late_minutes)) : '-';
            },
          },
          {
            key: 'status',
            label: 'Status',
            render: function (r) {
              return App.badge(r.status);
            },
          },
          { key: 'note', label: 'Keterangan' },
        ];

        var stats =
          '<div class="stat-grid">' +
            statBox('Hari Tercatat', esc(App.fmtNumber(d.meta.total))) +
            statBox('Hadir', esc(App.fmtNumber(d.totals.hadir))) +
            statBox('Dinas Luar', esc(App.fmtNumber(d.totals.dinas_luar))) +
            statBox('Izin', esc(App.fmtNumber(d.by_status.izin || 0))) +
            statBox('Sakit', esc(App.fmtNumber(d.by_status.sakit || 0))) +
            statBox('Cuti', esc(App.fmtNumber(d.by_status.cuti || 0))) +
          '</div>';

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Rekap Kehadiran Saya</h2>' +
            '<span class="small faint">' + esc(d.range.from) + ' s/d ' + esc(d.range.to) + '</span>' +
          '</div>' +
          '<div class="card-body">' + stats + '</div>' +
          '<div class="card-body tight">' +
            App.table(columns, d.rows, { empty: 'Belum ada rekap pada periode ini.' }) +
          '</div>' +
          (d.meta.total_pages > 1
            ? '<div class="card-body"><div class="small faint">Menampilkan ' +
              esc(d.rows.length) + ' dari ' + esc(d.meta.total) + ' hari.</div></div>'
            : '');
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat rekap', err);
      });
  }

  function errorBlock(title, err) {
    return (
      '<div class="card-header"><h2 class="card-title">' + esc(title) + '</h2></div>' +
      '<div class="card-body"><div class="empty-state">' +
        '<div class="big">&#9888;</div>' +
        '<div>' + esc(err.message || 'Terjadi kesalahan.') + '</div>' +
      '</div></div>'
    );
  }

  window.Pages.employee = render;
})();