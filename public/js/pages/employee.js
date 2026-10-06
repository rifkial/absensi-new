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
            'GPS diblokir browser karena koneksi ' + window.location.origin + ' tidak aman (HTTP). ' +
            'Aktifkan chrome://flags > Insecure origins treated as secure > isi ' + window.location.origin + ' > Enabled > Relaunch, atau pakai HTTPS.'
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
      '<div id="empShiftCard" class="card"><div class="card-body">' +
        App.loading('Memuat shift & jadwal...') +
      '</div></div>' +
      '<div id="empDutyCard" class="card"></div>' +
      '<div id="empLeaveCard" class="card"></div>' +
      '<div id="empReimburseCard" class="card"></div>' +
      '<div id="empRecapCard" class="card"></div>';

    loadProfile();
    loadToday();
    loadShiftSchedule();
    loadDuty();
    loadLeaves();
    loadReimburses();
    loadRecap();

    if (!el._notifBound) {
      el._notifBound = true;
      window.addEventListener('notif:dinas', function () {
        loadToday();
        loadShiftSchedule();
        loadDuty();
        loadLeaves();
        loadReimburses();
        loadRecap();
      });
    }
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

  // -------------------------------------------------------- Shift & jadwal

  /** Kartu shift default + jadwal per tanggal (jadwal > shift default). */
  function loadShiftSchedule() {
    var el = document.getElementById('empShiftCard');
    if (!el) return;

    Promise.all([api.get('/me/profile'), api.get('/me/schedule')])
      .then(function (res) {
        var shift = res[0].data.shift;
        var sched = res[1].data || {};
        var rows = sched.rows || [];
        var todayStr = App.today();
        var todayRow = null;
        var tomorrowRow = null;
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i].work_date === todayStr) todayRow = rows[i];
          if (rows[i].work_date === App.addDays(todayStr, 1)) tomorrowRow = rows[i];
        }

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Shift & Jadwal Saya</h2>' +
            '<span class="small faint">' + esc(sched.from || '') + ' s/d ' + esc(sched.to || '') + '</span>' +
          '</div>' +
          '<div class="card-body">' +
            '<div class="stat-grid">' +
              statBox('Shift Default', shift ? esc(shift.code + ' ' + fmtShiftTime(shift)) : '-') +
              statBox('Hari Ini', (todayRow ? esc(shiftLabel(todayRow)) : '-') +
                (todayRow && todayRow.note ? '<div class="small faint">' + esc(todayRow.note) + '</div>' : '')) +
              statBox('Besok', tomorrowRow ? esc(shiftLabel(tomorrowRow)) : '-') +
            '</div>' +
            '<div class="callout">Jadwal per tanggal menentukan absensi. ' +
              (shift && isOvernightShift(shift)
                ? 'Shift malam lintas hari: pulang tercatat besok pagi, tetap dihitung tanggal mulai shift.'
                : 'Tanpa jadwal = ikut shift default; tanpa shift = ikut jam global.') +
            '</div>' +
          '</div>' +
          '<div class="card-body tight">' + scheduleTable(rows) + '</div>';
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat shift & jadwal', err);
      });
  }

  function fmtShiftTime(s) {
    if (!s || !s.start_time) return '';
    return '(' + App.fmtTime(s.start_time) + '-' + App.fmtTime(s.end_time) + ')';
  }

  function isOvernightShift(s) {
    if (!s || !s.start_time || !s.end_time) return false;
    return String(s.end_time).slice(0, 5) <= String(s.start_time).slice(0, 5);
  }

  function shiftLabel(row) {
    if (!row || row.day_type === 'libur' || !row.shift) return 'Libur';
    return (row.shift.code || '') + ' ' + fmtShiftTime(row.shift) +
      (row.source === 'schedule' ? ' (jadwal)' : row.source === 'global' ? ' (global)' : '');
  }

  function scheduleTable(rows) {
    var show = (rows || []).slice(0, 14);
    var columns = [
      {
        key: 'work_date', label: 'Tanggal',
        render: function (r) {
          var isToday = r.work_date === App.today();
          return '<strong>' + esc(App.fmtDate(r.work_date)) + '</strong>' +
            (isToday ? ' <span class="badge info">Hari ini</span>' : '');
        },
      },
      {
        key: 'shift', label: 'Shift',
        render: function (r) {
          if (!r.shift) return '<span class="faint">-</span>';
          return esc((r.shift.code || '') + ' ' + fmtShiftTime(r.shift)) +
            (isOvernightShift(r.shift) ? ' <span class="badge warning">malam</span>' : '');
        },
      },
      {
        key: 'day_type', label: 'Jenis',
        render: function (r) {
          if (r.day_type === 'libur') return '<span class="badge hari_libur">Libur</span>';
          if (r.day_type === 'cuti') return '<span class="badge cuti">Cuti</span>';
          return '<span class="badge success">Kerja</span>';
        },
      },
      { key: 'note', label: 'Catatan', render: function (r) { return r.note ? esc(r.note) : '<span class="faint">-</span>'; } },
    ];
    return App.table(columns, show, { empty: 'Belum ada jadwal.' });
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
              statBox('Durasi Kerja', App.fmtMinutes(daily.work_minutes)) +
              statBox('Lembur', App.fmtMinutes(daily.overtime_minutes)) +
            '</div>' +
            (daily.note ? '<div class="callout">' + esc(daily.note) + '</div>' : '');
        } else {
          body = '<div class="empty-state">Rekap hari ini belum tersedia.</div>';
        }

        var action = '';
        if (d.can_check_in) {
          action =
            '<div style="margin-top:12px">' +
              '<button class="btn primary" id="btnTodayCheckin">Check-in Dinas</button>' +
            '</div>';
        } else if (d.duty && !d.duty.check_out_at) {
          action =
            '<div style="margin-top:12px">' +
              '<button class="btn primary" id="btnTodayCheckout">Check-out Dinas</button>' +
            '</div>';
        }

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Hari Ini</h2>' +
            '<span class="small faint">' + esc(d.work_date) + '</span>' +
          '</div>' +
          '<div class="card-body">' + body + action + '</div>';

        bindTodayActions(d);
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat status hari ini', err);
      });
  }

  function bindTodayActions(d) {
    var inBtn = document.getElementById('btnTodayCheckin');
    if (inBtn) {
      inBtn.addEventListener('click', function () {
        var duty = document.getElementById('empDutyCard');
        if (duty) duty.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var selfie = document.getElementById('dutySelfie');
        if (selfie) selfie.focus();
      });
    }
    var outBtn = document.getElementById('btnTodayCheckout');
    if (outBtn) {
      outBtn.addEventListener('click', function () {
        openCheckoutModal(d ? d.work_date : App.today());
      });
    }
  }

  function statBox(label, valueHtml) {
    return (
      '<div class="stat">' +
        '<div class="stat-label">' + esc(label) + '</div>' +
        '<div class="stat-value">' + valueHtml + '</div>' +
      '</div>'
    );
  }

  // -------------------------------------------------------- Dinas (dalam/luar kota)

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
            '<div class="callout success"><strong>Sudah check-in dinas</strong> ' +
              'Check-in ' + esc(clockOf(loc.check_in_at) || '-') + ' di ' +
              esc(Number(loc.latitude).toFixed(6)) + ', ' +
              esc(Number(loc.longitude).toFixed(6)) + accuracyLabel(loc.accuracy_m) + '. ' +
              (loc.selfie_url
                ? '<button class="btn sm" data-selfie="' + esc(loc.selfie_url) + '" data-title="Selfie Check-in">Foto In</button> '
                : '') +
              (loc.check_out_at
                ? 'Check-out ' + esc(clockOf(loc.check_out_at) || '-') + '. ' +
                  (loc.selfie_out_url
                    ? '<button class="btn sm" data-selfie="' + esc(loc.selfie_out_url) + '" data-title="Selfie Check-out">Foto Out</button>'
                    : '<span class="faint">(tanpa foto out)</span>')
                : 'Belum check-out.') +
            '</div>' +
            (loc.check_out_at
              ? ''
              : '<button class="btn primary" id="btnDutyCheckout">Check-out Dinas (wajib selfie)</button>');
        } else {
          bodyHtml =
            '<div class="callout ' + (today.can_check_in ? 'success' : 'warning') + '">' +
              esc(today.check_in_blocked_reason || '') +
            '</div>' +
            (today.can_check_in ? dutyFormHtml(today) : '');
        }

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Dinas</h2>' +
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
        bindSelfieButtons(el);
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat data dinas', err);
      });
  }

  function dutyFormHtml(today) {
    return (
      '<div class="callout">' +
        'Check-in dinas wajib menyertakan lokasi GPS dan foto selfie. ' +
        'Jam dicatat dari server, bukan dari jam perangkat.' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="field">' +
          '<label>Keterangan (opsional)</label>' +
          '<input type="text" id="dutyNote" maxlength="500" placeholder="Contoh: Meeting Antimunisi Surabaya">' +
        '</div>' +
        '<div class="field">' +
          '<label>Foto Selfie <span class="req">*</span></label>' +
          '<video id="dutyVideo" playsinline muted style="display:none;width:100%;max-width:320px;border-radius:8px;background:#000"></video>' +
          '<canvas id="dutyCanvas" style="display:none"></canvas>' +
          '<img id="dutyPreview" alt="Pratinjau selfie" style="display:none;width:100%;max-width:320px;border-radius:8px">' +
          '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">' +
            '<button type="button" class="btn sm" id="btnCamOpen">Buka Kamera</button>' +
            '<button type="button" class="btn sm primary" id="btnCamSnap" style="display:none">Ambil Foto</button>' +
            '<button type="button" class="btn sm" id="btnCamRetry" style="display:none">Ulangi</button>' +
          '</div>' +
          '<span class="help" id="dutyCamText">Izin kamera diminta saat tombol dibuka. Bila ditolak, pakai upload file.</span>' +
          '<input type="file" id="dutySelfie" accept="image/jpeg,image/png,image/webp" capture="user" style="margin-top:8px">' +
          '<span class="help">JPG/PNG/WEBP, maksimal 5 MB.</span>' +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<label>Lokasi GPS <span class="req">*</span></label>' +
        '<div class="row" style="gap:8px;flex-wrap:wrap">' +
          '<button type="button" class="btn" id="btnGetLocation">Ambil Lokasi Saya</button>' +
          '<button type="button" class="btn sm" id="btnPermLocation">Cek Izin Lokasi</button>' +
        '</div>' +
        '<span class="help" id="dutyLocText">Belum diambil.</span>' +
        '<div class="form-grid" style="margin-top:8px">' +
          '<div class="field"><label>Lat manual</label>' +
            '<input type="number" id="dutyLat" step="any" min="-90" max="90" placeholder="-6.2"></div>' +
          '<div class="field"><label>Lng manual</label>' +
            '<input type="number" id="dutyLng" step="any" min="-180" max="180" placeholder="106.8"></div>' +
        '</div>' +
        '<div class="row" style="gap:8px;margin-top:4px">' +
          '<button type="button" class="btn sm" id="btnMapPick">Pilih dari Peta</button>' +
          '<button type="button" class="btn sm" id="btnManualLoc">Pakai Koordinat Manual</button>' +
        '</div>' +
        '<span class="help">Bila GPS diblokir browser: pilih titik di peta / salin dari Google Maps > kirim tetap bisa.</span>' +
      '</div>' +
      '<button class="btn primary" id="btnDutyCheckin">Kirim Check-in (' + esc(today.work_date) + ')</button>'
    );
  }

  function bindDutyForm(el, today) {
    var getBtn = document.getElementById('btnGetLocation');
    var permBtn = document.getElementById('btnPermLocation');
    var submitBtn = document.getElementById('btnDutyCheckin');
    if (!getBtn || !submitBtn) return;

    var coords = null;
    var locText = document.getElementById('dutyLocText');
    var cam = bindDutyCamera();

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

    var mapBtn = document.getElementById('btnMapPick');
    if (mapBtn) {
      mapBtn.addEventListener('click', function () {
        openMapPicker(function (lat, lng) {
          document.getElementById('dutyLat').value = lat.toFixed(6);
          document.getElementById('dutyLng').value = lng.toFixed(6);
          coords = { latitude: lat, longitude: lng, accuracy: null, manual: true };
          locText.innerHTML = '<strong>' + esc(lat.toFixed(6)) + ', ' + esc(lng.toFixed(6)) + '</strong> &middot; dari peta';
          App.toast('Titik peta dipakai.', 'success');
        });
      });
    }

    var manualBtn = document.getElementById('btnManualLoc');
    if (manualBtn) {
      manualBtn.addEventListener('click', function () {
        var lat = Number(document.getElementById('dutyLat').value);
        var lng = Number(document.getElementById('dutyLng').value);
        if (!isFinite(lat) || lat < -90 || lat > 90 || !isFinite(lng) || lng < -180 || lng > 180) {
          App.toast('Lat -90..90, Lng -180..180 wajib diisi.', 'error');
          return;
        }
        coords = { latitude: lat, longitude: lng, accuracy: null, manual: true };
        locText.innerHTML = '<strong>' + esc(lat.toFixed(6)) + ', ' + esc(lng.toFixed(6)) + '</strong> &middot; manual';
        App.toast('Koordinat manual dipakai.', 'success');
      });
    }

    if (permBtn) {
      permBtn.addEventListener('click', function () {
        if (window.isSecureContext === false) {
          var insecureMsg =
            'Koneksi ' + window.location.origin + ' tidak aman (HTTP), browser memblokir GPS. ' +
            'Buka chrome://flags > Insecure origins treated as secure > isi ' + window.location.origin + ' > Enabled > Relaunch, atau isi Lat/Lng manual.';
          locText.innerHTML = '<strong>' + esc(insecureMsg) + '</strong>';
          App.toast(insecureMsg, 'error');
          return;
        }
        checkLocationPermission()
          .then(function (state) {
            var msg = {
              granted: 'Izin lokasi: diizinkan. Klik Ambil Lokasi Saya.',
              prompt: 'Izin lokasi: belum diputuskan. Klik Ambil Lokasi Saya lalu pilih Izinkan.',
              denied: 'Izin lokasi: ditolak. Buka ikon gembok di address bar > izin lokasi > Izinkan, lalu muat ulang.',
            }[state] || ('Status izin lokasi: ' + state);
            locText.innerHTML = '<strong>' + esc(msg) + '</strong>';
            App.toast(msg, state === 'granted' ? 'success' : 'error');
          })
          .catch(function (err) {
            App.toast(err.message, 'error');
          });
      });
    }

    submitBtn.addEventListener('click', function () {
      var fileInput = document.getElementById('dutySelfie');
      var file = (cam && cam.snapshotFile) || (fileInput.files && fileInput.files[0]);

      if (!coords) {
        App.toast('Ambil lokasi GPS terlebih dahulu.', 'error');
        return;
      }
      if (!file) {
        App.toast('Ambil foto selfie dari kamera atau upload file.', 'error');
        return;
      }

      var fd = new FormData();
      fd.append('work_date', today.work_date);
      fd.append('latitude', String(coords.latitude));
      fd.append('longitude', String(coords.longitude));
      if (coords.accuracy !== null && coords.accuracy !== undefined && coords.accuracy !== '') {
        fd.append('accuracy', String(coords.accuracy));
      }
      if (coords.manual) {
        fd.append('note', ('[koordinat manual] ' + document.getElementById('dutyNote').value.trim()).slice(0, 500));
      } else {
        fd.append('note', document.getElementById('dutyNote').value.trim());
      }
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

  var leafletLoading = null;

  /** Muat Leaflet lokal (public/vendor) sekali saja. Tanpa CDN luar. */
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise(function (resolve, reject) {
      if (!document.querySelector('link[data-leaflet]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/vendor/leaflet/leaflet.css';
        link.setAttribute('data-leaflet', '1');
        document.head.appendChild(link);
      }
      var s = document.createElement('script');
      s.src = '/vendor/leaflet/leaflet.js';
      s.onload = function () { resolve(); };
      s.onerror = function () {
        leafletLoading = null;
        reject(new Error('Peta gagal dimuat dari server lokal (/vendor/leaflet). Restart server lalu coba lagi.'));
      };
      document.head.appendChild(s);
    });
    return leafletLoading;
  }

  /**
   * Popup pilih titik di peta CARTO (data OSM). Klik peta = pindah pin.
   * Tombol Pakai Titik Ini mengisi Lat/Lng via callback. Ada pencarian
   * nama (Photon) + tombol GPS bila izin tersedia.
   */
  function openMapPicker(onPick) {
    var latInput = document.getElementById('dutyLat');
    var lngInput = document.getElementById('dutyLng');
    var startLat = Number(latInput && latInput.value) || -6.2;
    var startLng = Number(lngInput && lngInput.value) || 106.8;
    if (!isFinite(startLat) || startLat < -90 || startLat > 90) startLat = -6.2;
    if (!isFinite(startLng) || startLng < -180 || startLng > 180) startLng = 106.8;

    App.modal({
      title: 'Pilih Titik Lokasi',
      size: 'wide',
      bodyHtml:
        '<div class="row" style="gap:8px;margin-bottom:8px">' +
          '<input type="text" id="mapSearch" placeholder="Cari: nama jalan / gedung / kota" style="flex:1;min-width:180px">' +
          '<button type="button" class="btn sm" id="mapSearchBtn">Cari</button>' +
          '<button type="button" class="btn sm" id="mapGpsBtn">GPS Saya</button>' +
        '</div>' +
        '<div id="mapPick" style="height:340px;border-radius:8px;border:1px solid var(--border)"></div>' +
        '<div class="small faint" style="margin-top:6px" id="mapPickText">Klik peta untuk pindah pin.</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Pakai Titik Ini',
          className: 'primary',
          onClick: function (el) {
            var lat = el._pickedLat;
            var lng = el._pickedLng;
            if (!isFinite(lat) || !isFinite(lng)) {
              App.toast('Klik peta dulu untuk memilih titik.', 'error');
              return false;
            }
            onPick(lat, lng);
          },
        },
      ],
      onMount: function (backdrop) {
        backdrop._pickedLat = startLat;
        backdrop._pickedLng = startLng;
        var textEl = backdrop.querySelector('#mapPickText');
        function say(lat, lng) {
          backdrop._pickedLat = lat;
          backdrop._pickedLng = lng;
          if (textEl) textEl.textContent = lat.toFixed(6) + ', ' + lng.toFixed(6);
        }
        loadLeaflet().then(function () {
          var map = window.L.map(backdrop.querySelector('#mapPick')).setView([startLat, startLng], 15);
          window.L.tileLayer('/api/geo/tiles/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap',
          }).addTo(map);
          var marker = window.L.marker([startLat, startLng], { draggable: true }).addTo(map);
          say(startLat, startLng);
          map.on('click', function (e) {
            marker.setLatLng(e.latlng);
            say(e.latlng.lat, e.latlng.lng);
          });
          marker.on('dragend', function () {
            var p = marker.getLatLng();
            say(p.lat, p.lng);
          });
          setTimeout(function () { map.invalidateSize(); }, 150);

          backdrop.querySelector('#mapSearchBtn').addEventListener('click', function () {
            var q = backdrop.querySelector('#mapSearch').value.trim();
            if (!q) return;
            api.get('/geo/search', { q: q })
              .then(function (res) {
                var row = res.data && res.data[0];
                if (!row) {
                  App.toast('Lokasi tidak ditemukan.' + (res.warning ? ' ' + res.warning : ''), 'error');
                  return;
                }
                map.setView([row.lat, row.lng], 16);
                marker.setLatLng([row.lat, row.lng]);
                say(row.lat, row.lng);
                if (row.label) App.toast(row.label, 'success');
              })
              .catch(function (err) { App.toast(err.message, 'error'); });
          });

          backdrop.querySelector('#mapGpsBtn').addEventListener('click', function () {
            getCoordinates().then(
              function (c) {
                map.setView([c.latitude, c.longitude], 17);
                marker.setLatLng([c.latitude, c.longitude]);
                say(c.latitude, c.longitude);
              },
              function (err) { App.toast(err.message, 'error'); }
            );
          });
        }).catch(function (err) {
          if (textEl) textEl.textContent = err.message;
          App.toast(err.message, 'error');
        });
      },
    });
  }

  /** Status izin lokasi via Permissions API (fallback: tidak didukung). */
  function checkLocationPermission() {
    return new Promise(function (resolve, reject) {
      if (!navigator.permissions || !navigator.permissions.query) {
        reject(new Error('Browser ini tidak mendukung cek izin lokasi. Langsung klik Ambil Lokasi Saya.'));
        return;
      }
      navigator.permissions.query({ name: 'geolocation' }).then(
        function (status) { resolve(status.state); },
        function () { reject(new Error('Gagal membaca status izin lokasi.')); }
      );
    });
  }

  /**
   * Kamera live untuk selfie dinas. Hasil jepretan disimpan sebagai File di
   * cam.snapshotFile sehingga submit tidak bergantung pada input file.
   * Stream dimatikan saat check-in terkirim / halaman dimuat ulang.
   */
  function bindDutyCamera(ids) {
    var p = ids || {};
    var submitLabel = p.submitLabel || 'Kirim Check-in';
    var openBtn = document.getElementById(p.open || 'btnCamOpen');
    var snapBtn = document.getElementById(p.snap || 'btnCamSnap');
    var retryBtn = document.getElementById(p.retry || 'btnCamRetry');
    var video = document.getElementById(p.video || 'dutyVideo');
    var canvas = document.getElementById(p.canvas || 'dutyCanvas');
    var preview = document.getElementById(p.preview || 'dutyPreview');
    var camText = document.getElementById(p.camText || 'dutyCamText');
    var fileInput = document.getElementById(p.file || 'dutySelfie');
    if (!openBtn || !video) return null;

    var cam = { stream: null, snapshotFile: null };

    function stopStream() {
      if (cam.stream) {
        cam.stream.getTracks().forEach(function (t) { t.stop(); });
        cam.stream = null;
      }
      video.style.display = 'none';
      if (snapBtn) snapBtn.style.display = 'none';
    }

    function say(msg, isError) {
      if (camText) camText.innerHTML = '<strong>' + esc(msg) + '</strong>';
      App.toast(msg, isError ? 'error' : 'success');
    }

    openBtn.addEventListener('click', function () {
      if (window.isSecureContext === false) {
        say(
          'Kamera diblokir browser karena ' + window.location.origin + ' tidak aman (HTTP). ' +
          'Aktifkan chrome://flags > Insecure origins treated as secure > isi ' + window.location.origin + ' > Enabled > Relaunch, ' +
          'atau pakai upload file: foto dulu pakai kamera HP lalu pilih file.',
          true
        );
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        say('Browser ini tidak mendukung kamera. Pakai upload file: foto dulu pakai kamera HP lalu pilih file.', true);
        return;
      }
      openBtn.disabled = true;
      say('Meminta izin kamera...');
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then(
        function (stream) {
          cam.stream = stream;
          cam.snapshotFile = null;
          video.srcObject = stream;
          video.style.display = '';
          if (preview) preview.style.display = 'none';
          if (snapBtn) snapBtn.style.display = '';
          if (retryBtn) retryBtn.style.display = 'none';
          if (fileInput) fileInput.value = '';
          video.play().catch(function () {});
          say('Kamera aktif. Posisikan wajah lalu klik Ambil Foto.');
          openBtn.disabled = false;
        },
        function (err) {
          openBtn.disabled = false;
          var msg = err && err.name === 'NotAllowedError'
            ? 'Izin kamera ditolak. Klik ikon kamera/gembok di address bar > Izinkan > muat ulang, atau pakai upload file.'
            : 'Kamera gagal dibuka: ' + ((err && err.message) || err) + '. Pakai upload file.';
          say(msg, true);
        }
      );
    });

    if (snapBtn) {
      snapBtn.addEventListener('click', function () {
        if (!cam.stream || !video.videoWidth) {
          say('Kamera belum siap. Buka kamera dulu.', true);
          return;
        }
        var w = Math.min(960, video.videoWidth);
        var h = Math.round((w / video.videoWidth) * video.videoHeight);
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          function (blob) {
            if (!blob) {
              say('Gagal mengambil foto. Coba lagi.', true);
              return;
            }
            cam.snapshotFile = new File([blob], 'selfie-' + Date.now() + '.jpg', { type: 'image/jpeg' });
            if (preview) {
              preview.src = URL.createObjectURL(blob);
              preview.style.display = '';
            }
            stopStream();
            if (retryBtn) retryBtn.style.display = '';
            say('Foto diambil (' + Math.round(blob.size / 1024) + ' KB). Klik ' + submitLabel + '.');
          },
          'image/jpeg',
          0.85
        );
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        cam.snapshotFile = null;
        if (preview) {
          preview.style.display = 'none';
          preview.src = '';
        }
        retryBtn.style.display = 'none';
        openBtn.click();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files[0]) {
          cam.snapshotFile = null;
          if (preview) preview.style.display = 'none';
          stopStream();
          if (retryBtn) retryBtn.style.display = 'none';
          say('File dipilih: ' + fileInput.files[0].name);
        }
      });
    }

    window.addEventListener('beforeunload', stopStream);
    return cam;
  }

  /** Modal check-out: wajib selfie seperti check-in (kamera live / upload). */
  function openCheckoutModal(workDate) {
    App.modal({
      title: 'Check-out Dinas (' + workDate + ')',
      bodyHtml:
        '<div class="callout">Check-out wajib foto selfie. Jam dicatat dari server.</div>' +
        '<video id="outVideo" playsinline muted style="display:none;width:100%;max-width:320px;border-radius:8px;background:#000"></video>' +
        '<canvas id="outCanvas" style="display:none"></canvas>' +
        '<img id="outPreview" alt="Pratinjau selfie check-out" style="display:none;width:100%;max-width:320px;border-radius:8px">' +
        '<div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">' +
          '<button type="button" class="btn sm" id="outCamOpen">Buka Kamera</button>' +
          '<button type="button" class="btn sm primary" id="outCamSnap" style="display:none">Ambil Foto</button>' +
          '<button type="button" class="btn sm" id="outCamRetry" style="display:none">Ulangi</button>' +
        '</div>' +
        '<span class="help" id="outCamText">Izin kamera diminta saat tombol dibuka. Bila ditolak, pakai upload file.</span>' +
        '<div class="field" style="margin-top:8px"><label>Foto Selfie Check-out <span class="req">*</span></label>' +
          '<input type="file" id="outSelfie" accept="image/jpeg,image/png,image/webp" capture="user">' +
          '<span class="help">JPG/PNG/WEBP, maksimal 5 MB.</span></div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Kirim Check-out',
          className: 'primary',
          onClick: function (el) {
            var fileInput = el.querySelector('#outSelfie');
            var file = (el._outCam && el._outCam.snapshotFile) || (fileInput.files && fileInput.files[0]);
            if (!file) {
              App.toast('Ambil foto selfie check-out dulu.', 'error');
              return false;
            }
            var fd = new FormData();
            fd.append('work_date', workDate);
            fd.append('selfie', file, file.name);
            var btn = el.querySelector('[data-action-index="1"]');
            if (btn) btn.disabled = true;
            api
              .upload('/me/duty-checkins/check-out', fd)
              .then(function () {
                App.toast('Check-out dinas dicatat.', 'success');
                el.closeModal();
                loadToday();
                loadDuty();
                loadRecap();
              })
              .catch(function (err) {
                App.toast(err.message, 'error');
                if (btn) btn.disabled = false;
              });
            return false;
          },
        },
      ],
      onMount: function (backdrop) {
        backdrop._outCam = bindDutyCamera({
          open: 'outCamOpen', snap: 'outCamSnap', retry: 'outCamRetry',
          video: 'outVideo', canvas: 'outCanvas', preview: 'outPreview',
          camText: 'outCamText', file: 'outSelfie', submitLabel: 'Kirim Check-out',
        });
      },
    });
  }

  function bindDutyCheckout() {
    var btn = document.getElementById('btnDutyCheckout');
    if (!btn) return;

    btn.addEventListener('click', function () {
      openCheckoutModal(App.today());
    });
  }

  function dutyHistoryTable(rows) {
    var columns = [
      { key: 'work_date', label: 'Tanggal' },
      {
        key: 'detail',
        label: 'Detail Check-in / Check-out',
        render: function (r) {
          var parts = [];
          parts.push(
            '<div><strong>In:</strong> ' + esc(r.jam_masuk || '-') +
            (r.selfie_url
              ? ' <button class="btn sm" data-selfie="' + esc(r.selfie_url) + '" data-title="Selfie Check-in">Foto In</button>'
              : ' <span class="faint">(tanpa foto)</span>') + '</div>'
          );
          parts.push(
            '<div><strong>Out:</strong> ' + esc(r.jam_keluar || '-') +
            (r.selfie_out_url
              ? ' <button class="btn sm" data-selfie="' + esc(r.selfie_out_url) + '" data-title="Selfie Check-out">Foto Out</button>'
              : ' <span class="faint">(belum check-out)</span>') + '</div>'
          );
          return parts.join('');
        },
      },
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
    ];

    var html = App.table(columns, rows, {
      empty: 'Belum ada riwayat dinas.',
      emptyIcon: '&#128188;',
    });

    if (rows.length >= 20) {
      html += '<div class="card-body"><div class="small faint">20 data terakhir ditampilkan.</div></div>';
    }

    // Delegasi event setelah tabel masuk DOM.
    setTimeout(function () {
      bindSelfieButtons(document);
    }, 0);

    return html;
  }

  function bindSelfieButtons(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('[data-selfie]'), function (btn) {
      if (btn._selfieBound) return;
      btn._selfieBound = true;
      btn.addEventListener('click', function () {
        openSelfie(btn.getAttribute('data-selfie'), btn.getAttribute('data-title'));
      });
    });
  }

  /** Selfie dilindungi token, jadi diambil lewat fetch lalu ditampilkan di modal. */
  function openSelfie(url, title) {
    fetch(url, { headers: { Authorization: 'Bearer ' + api.token } })
      .then(function (res) {
        if (!res.ok) throw new Error('Foto tidak dapat dimuat (' + res.status + ').');
        return res.blob();
      })
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);
        App.modal({
          title: title || 'Foto Selfie Dinas Luar Kota',
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

  // --------------------------------------------------------- Reimburse

  function loadReimburses() {
    var el = document.getElementById('empReimburseCard');
    if (!el) return;

    api
      .get('/me/reimburses', { limit: 50 })
      .then(function (res) {
        var rows = res.data || [];
        var columns = [
          { key: 'description', label: 'Deskripsi' },
          {
            key: 'amount', label: 'Jumlah', align: 'right',
            render: function (r) { return 'Rp ' + esc(App.fmtNumber(r.amount || 0)); },
          },
          {
            key: 'receipt_url', label: 'Bukti',
            render: function (r) {
              return r.receipt_url
                ? '<button class="btn sm" data-receipt="' + esc(r.receipt_url) + '">Lihat</button>'
                : '<span class="faint">-</span>';
            },
          },
          {
            key: 'status', label: 'Status',
            render: function (r) {
              var cls = r.status === 'approved' ? 'hadir' : r.status === 'rejected' ? 'alpa' : 'telat';
              return '<span class="badge ' + cls + '">' +
                esc(App.LEAVE_STATUS_LABELS[r.status] || r.status) + '</span>';
            },
          },
          { key: 'created_at', label: 'Diajukan', render: function (r) { return esc(App.fmtDateTime(r.created_at)); } },
        ];

        el.innerHTML =
          '<div class="card-header">' +
            '<h2 class="card-title">Reimburse Biaya Perjalanan</h2>' +
            '<button class="btn primary sm" id="btnNewReimburse">+ Ajukan Reimburse</button>' +
          '</div>' +
          '<div class="card-body tight">' +
            App.table(columns, rows, { empty: 'Belum ada reimburse.' }) +
          '</div>';

        document.getElementById('btnNewReimburse').addEventListener('click', openReimburseForm);

        Array.prototype.forEach.call(el.querySelectorAll('[data-receipt]'), function (btn) {
          btn.addEventListener('click', function () {
            openReceipt(btn.getAttribute('data-receipt'));
          });
        });
      })
      .catch(function (err) {
        el.innerHTML = errorBlock('Gagal memuat reimburse', err);
      });
  }

  /** Buka bukti struk: gambar tampil modal, PDF buka tab baru (ber-token). */
  function openReceipt(url) {
    fetch(url, { headers: { Authorization: 'Bearer ' + api.token } })
      .then(function (res) {
        if (!res.ok) throw new Error('Bukti tidak dapat dimuat (' + res.status + ').');
        var type = res.headers.get('content-type') || '';
        return res.blob().then(function (blob) { return { blob: blob, type: type }; });
      })
      .then(function (r) {
        var objectUrl = URL.createObjectURL(r.blob);
        if (/pdf/i.test(r.type)) {
          window.open(objectUrl, '_blank');
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
          return;
        }
        App.modal({
          title: 'Bukti Reimburse',
          bodyHtml: '<img src="' + objectUrl + '" alt="Bukti reimburse" style="width:100%;border-radius:8px">',
          actions: [{ label: 'Tutup' }],
          onClose: function () { URL.revokeObjectURL(objectUrl); },
        });
      })
      .catch(function (err) { App.toast(err.message, 'error'); });
  }

  function openReimburseForm() {
    App.modal({
      title: 'Ajukan Reimburse Perjalanan',
      size: 'wide',
      bodyHtml:
        '<div class="callout">Tambah baris bila ada banyak biaya. Tiap baris boleh lampirkan bukti sendiri.</div>' +
        '<div id="rbRows"></div>' +
        '<button type="button" class="btn sm" id="rbAdd">+ Tambah Biaya</button>' +
        '<div class="small faint mt" id="rbTotal">Total: Rp 0</div>' +
        '<div class="callout mt">Diteruskan ke admin/HR. Notifikasi realtime masuk saat disetujui/ditolak.</div>',
      actions: [
        { label: 'Batal' },
        {
          label: 'Kirim Pengajuan',
          className: 'primary',
          onClick: function (el) {
            var rows = el.querySelectorAll('.rb-row');
            if (rows.length === 0) { App.toast('Tambah minimal satu biaya.', 'error'); return false; }
            var items = [];
            var fd = new FormData();
            var total = 0;
            for (var i = 0; i < rows.length; i += 1) {
              var desc = rows[i].querySelector('.rb-desc').value.trim();
              var amount = App.parseRupiah(rows[i].querySelector('.rb-amount').value);
              var fileInput = rows[i].querySelector('.rb-file');
              var file = fileInput.files && fileInput.files[0];
              if (!desc) { App.toast('Baris ' + (i + 1) + ': deskripsi wajib diisi.', 'error'); return false; }
              if (!amount || amount <= 0) { App.toast('Baris ' + (i + 1) + ': jumlah harus > 0.', 'error'); return false; }
              if (file && file.size > 10 * 1024 * 1024) { App.toast('Baris ' + (i + 1) + ': bukti maksimal 10 MB.', 'error'); return false; }
              items.push({ description: desc, amount: amount });
              if (file) fd.append('receipts[' + i + ']', file, file.name);
              total += amount;
            }
            fd.append('items', JSON.stringify(items));
            api.upload('/me/reimburses/batch', fd)
              .then(function (res) {
                App.toast((res.count || items.length) + ' reimburse terkirim (total Rp ' + App.fmtNumber(total) + ').', 'success');
                el.closeModal();
                loadReimburses();
              })
              .catch(function (err) { App.toast(err.message, 'error'); });
            return false;
          },
        },
      ],
      onMount: function (backdrop) {
        var list = backdrop.querySelector('#rbRows');
        var totalEl = backdrop.querySelector('#rbTotal');

        function updateTotal() {
          var sum = 0;
          Array.prototype.forEach.call(backdrop.querySelectorAll('.rb-amount'), function (input) {
            sum += App.parseRupiah(input.value) || 0;
          });
          totalEl.textContent = 'Total: Rp ' + App.fmtNumber(sum) + ' (' + backdrop.querySelectorAll('.rb-row').length + ' item)';
        }

        function addRow() {
          var div = document.createElement('div');
          div.className = 'rb-row card-body';
          div.style.cssText = 'border:1px solid var(--border);border-radius:8px;margin-bottom:8px';
          div.innerHTML =
            '<div class="form-grid">' +
              '<div class="field"><label>Deskripsi <span class="req">*</span></label>' +
                '<input type="text" class="rb-desc" maxlength="500" placeholder="Contoh: BBM + tol dinas Surabaya"></div>' +
              '<div class="field"><label>Jumlah (Rp) <span class="req">*</span></label>' +
                '<div class="row"><span class="small faint">Rp</span>' +
                '<input type="text" class="rb-amount" inputmode="numeric" placeholder="150.000" style="flex:1"></div></div>' +
            '</div>' +
            '<div class="field mt"><label>Bukti (opsional)</label>' +
              '<input type="file" class="rb-file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment">' +
              '<span class="help">JPG/PNG/WEBP/PDF, maks 10 MB.</span></div>' +
            '<div class="row mt"><button type="button" class="btn sm danger rb-del">Hapus</button></div>';
          div.querySelector('.rb-del').addEventListener('click', function () {
            div.remove();
            updateTotal();
          });
          var amountInput = div.querySelector('.rb-amount');
          App.bindRupiah(amountInput);
          amountInput.addEventListener('input', updateTotal);
          list.appendChild(div);
          updateTotal();
        }

        backdrop.querySelector('#rbAdd').addEventListener('click', addRow);
        addRow();
      },
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
          {
            key: 'work_minutes',
            label: 'Durasi Kerja',
            align: 'right',
            render: function (r) { return esc(App.fmtMinutes(r.work_minutes)); },
          },
          {
            key: 'overtime_minutes',
            label: 'Lembur',
            align: 'right',
            render: function (r) {
              return (Number(r.overtime_minutes) || 0) > 0 ? esc(App.fmtMinutes(r.overtime_minutes)) : '-';
            },
          },
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
            statBox('Dinas Luar', esc(App.fmtNumber(d.totals.dinas_luar || d.by_status.dinas_luar || 0))) +
            statBox('Dinas Dalam', esc(App.fmtNumber(d.totals.dinas_dalam || d.by_status.dinas_dalam || 0))) +
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