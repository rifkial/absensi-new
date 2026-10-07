# Absensi Fingerprint

Aplikasi absensi fingerprint (Node.js + MySQL) dengan sinkronisasi mesin ZKTeco / PUSH.

Web UI + REST API di port `3000`, server PUSH/ADMS mesin di port `3001`.

## Fitur

- Karyawan, departemen, jabatan, shift, jadwal (versi UI 1.2.0 di sidebar + Status Sistem)
- Menu "Unit Kerja & Jabatan": data master divisi/departemen + jabatan (CRUD, kode unik)
- Absensi: statistik dinas luar/dalam terpisah; Dashboard: Hadir bersih, kartu Dinas sendiri, status kanal notif asli
- Tarik log dari mesin (polling TCP 4370) + mode PUSH (ADMS/icLock) + impor CSV
- Rekap harian/bulanan, telat, lembur, izin/sakit/cuti, dinas dalam/luar, alpa, hari libur
- Laporan 7 format + ekspor Excel + pratinjau pagination 50/halaman + cetak popup (kop + tabel saja)
- Hari libur nasional (UI + sinkronisasi API) + Kalender & event 60 hari di Dashboard
- Jejak audit di Pengaturan memakai pagination 10/halaman
- Pengajuan cuti/izin/dinas + reimburse (filter rentang tanggal, impor/ekspor Excel)
- Surat Perjalanan Dinas (nomor + transportasi, cetak) untuk dinas yang disetujui
- Portal mandiri karyawan (`role employee`): rekap, pengajuan, check-in dinas GPS + selfie
- Auto-sync mesin MATI default (tombol hidup/mati di menu Perangkat, tanpa restart)
- Sync manual jalan di background (202 + polling status, UI tidak menggantung)
- Notifikasi realtime SSE + bell unread + halaman riwayat `/#/notifications` (pagination, admin & employee), email SMTP + WhatsApp nomor sendiri (scan QR, antrean anti-banned FIFO + jeda acak + batas/menit/hari) / gateway
- WhatsApp broadcast multi-nomor (koma) + tombol pilih nomor dari data karyawan (langsung tersimpan)
- Peta Leaflet lokal (tanpa CDN luar, tile/search via proxy server)
- Backup & restore database khusus admin (tab Pengaturan > Backup, dump .sql JS murni tanpa mysqldump, retensi `BACKUP_KEEP`)
- Audit log, throttle login, JWT auth
- Frontend statis di `public/` (tanpa build, tanpa bundler)

## Teknologi

Node.js >= 18, Express 4, MySQL 5.7+ / MariaDB 10.4+ (XAMPP), JWT, bcryptjs, dayjs, exceljs, multer, nodemailer, whatsapp-web.js, qrcode.

## Struktur

```
src/server.js        # entry: 2 listener (web 3000 + PUSH 3001) + scheduler sync (MATI default)
src/app.js           # Express app, REST API, static frontend, proxy geo (tile/search)
src/config.js        # baca .env
src/db/              # pool, migrate, seed, upgrades
src/routes/          # auth, employees, shifts, holidays, devices, attendance, reports, settings, audit, me, notifications, whatsapp (self QR/status/kirim), master (unit kerja & jabatan), backup (admin)
src/services/        # attendance, reports, sync, notify, holidays, realtime (SSE), travelLetter, channels, whatsappSelf (QR + antrean), backup (dump .sql)
src/devices/         # adapter: zkteco-tcp, pushhttp, csv
src/middleware/      # auth (RBAC + cache user 30s), error
db/schema.sql        # skema idempoten
public/              # UI statis (index.html, css/, js/core+app+pages/, vendor/leaflet)
public/vendor/leaflet/ # Leaflet lokal (tanpa CDN luar)
tools/               # probe, scan, sync-once, cek-*
test/                # node:test (127 tes: shifts, attendance, travelLetter, realtime, dutyRange, whatsappThrottle, backup, ...)
```

## Syarat

- Node.js >= 18
- MySQL/MariaDB jalan (XAMPP)
- Database `absensi` (dibuat otomatis oleh `npm run migrate`)

## Mulai cepat

```bash
npm install
cp .env.example .env   # sesuaikan DB_*, JWT_SECRET, TZ
npm run setup          # migrate + seed
npm run dev            # atau npm start
```

Buka `http://localhost:3000`, login bawaan:

```
admin / admin123
```

Segera ganti password lewat menu Pengguna.

Health check (tanpa login):

```bash
curl http://localhost:3000/health
```

## Konfigurasi (.env)

Salin `.env.example` ke `.env`. Kunci penting:

| Key | Isi |
|---|---|
| `PORT` / `HOST` | web UI + API (default `3000` / `0.0.0.0`) |
| `PUSH_PORT` | server ADMS mesin (default `3001`, samakan dengan `PORT` untuk gabung) |
| `DB_*` | host, port, user, password, nama DB (`DB_CONNECTION_LIMIT` default `20`) |
| `JWT_SECRET` | wajib >= 32 karakter acak sebelum produksi |
| `TZ` | `Asia/Jakarta` (penting untuk shift & telat) |
| `SYNC_ENABLED` | auto-sync mesin, default `false` (MATI). Nyalakan manual via tombol di menu Perangkat / `POST /api/devices/scheduler` |
| `SYNC_INTERVAL_MINUTES` | polling otomatis mesin (bila `SYNC_ENABLED=true`, default `5`) |
| `DEVICE_TIMEOUT_MS` | timeout tarik log (default `20000`) |
| `DEVICE_CLEAR_LOG_AFTER_SYNC` | `true` = hapus log di mesin setelah sync |
| `ATTENDANCE_CUTOFF_TIME`, `DEFAULT_LATE_TOLERANCE`, `MAX_DAILY_WORK_MINUTES` | aturan rekap |
| `MAIL_*` | SMTP (aktif bila `MAIL_ENABLED=true`) |
| `WHATSAPP_PROVIDER` | `self` (nomor sendiri, scan QR) atau `gateway` (Fonnte/Wablas/custom), default `gateway` |
| `WHATSAPP_*` | gateway WA (aktif bila `WHATSAPP_ENABLED=true`); `WHATSAPP_SELF_SESSION` sesi QR, `WHATSAPP_SELF_AUTOSTART` sambung otomatis, `WHATSAPP_SELF_MIN/MAX_DELAY_MS` + `WHATSAPP_SELF_PER_MINUTE` + `WHATSAPP_SELF_DAILY_LIMIT` anti-banned |
| `WHATSAPP_TARGET` | nomor TUJUAN (bukan pengirim), boleh banyak koma untuk broadcast, mis. `62812xxxxxxx, 62813xxxxxxx` |
| `BACKUP_KEEP` | jumlah file backup terbaru di `storage/backups` (default `10`) |
| `BACKFILL_DAYS` | backfill rekap saat generate |

## Script

| Perintah | Fungsi |
|---|---|
| `npm start` | jalan produksi |
| `npm run dev` | jalan + `--watch` (auto-reload tiap simpan, tanpa restart manual) |
| `npm run setup` | `migrate + seed` |
| `npm run migrate` | jalankan `db/schema.sql` + `src/db/upgrades.js` (idempoten) |
| `npm run seed` | admin + karyawan demo (NIK `001-005`, PIN `1-5`) + shift/jadwal contoh |
| `npm run sync` | satu siklus sync lalu keluar (`--force`, `--days N`, `--device ID`) |
| `npm run probe -- <ip> [port] [pass]` | tes koneksi ke satu mesin |
| `npm run scan -- [prefix]` | pindai subnet cari mesin (contoh `192.168.1`) |
| `npm test` / `npm run build` | `node --test test/**/*.test.js` (127 tes) |
| `npm run lint` | eslint (butuh `eslint.config.js`, lihat migrasi ESLint v9) |

## Peran & izin

Role: `admin`, `hr`, `operator`, `viewer`, `employee`.

- `employees:write`, `shifts:write`, `holidays:write` = admin, hr
- `master:read` (lihat daftar unit kerja/jabatan) = semua role login; `master:write` (tambah/ubah/hapus) = admin, hr
- `devices:*`, `attendance:write` = admin, hr, operator
- `reports:read/export`, `attendance:read` = semua role login
- `settings`, `notify:send`, `audit:read`, `users:manage` = admin, hr
- `backup:manage` = admin saja (tab Pengaturan > Backup)
- `employee` = hanya data sendiri via `/api/me` + portal mandiri

## Mesin fingerprint

Protokol di `src/devices/`:

- `zkteco-tcp` — tarik via TCP port 4370 (default)
- `pushhttp` — mesin PUSH/ADMS ke `http://<ip-server>:3001/iclock/...`
- `csv` — impor file CSV

Alur: daftarkan mesin di menu Perangkat → tes koneksi → sync manual (tombol Sync / `npm run sync`) atau nyalakan auto-sync via tombol di menu Perangkat (`POST /api/devices/scheduler {enabled:true}`). Auto-sync MATI default (`SYNC_ENABLED=false`) supaya UI tidak berebut pool DB. Sync manual jalan di background: server balas `202 queued` langsung, status dipolling via `GET /api/devices/status`. `device_user_id` (PIN mesin) harus cocok dengan data karyawan, yang tak cocok masuk log mentah `unmatched`.

Cek cepat dari terminal:

```bash
npm run probe -- 192.168.1.201
npm run probe -- 192.168.1.201 4370 0
npm run scan -- 192.168.1
```

Untuk mode PUSH, isi IP server + `PUSH_PORT` di menu ADMS mesin. Bila `PUSH_AUTH_TOKEN` diisi, mesin wajib kirim token sama.

## Backup & restore database (khusus admin)

- Buka Pengaturan > Backup sebagai `admin`. Buat backup = file `.sql` tersimpan di `storage/backups` (retensi `BACKUP_KEEP`, default 10) — tanpa butuh `mysqldump`.
- Restore wajib ketik persis nama database (`DB_NAME`). Sistem otomatis: backup pra-restore (`pre-restore-*`, dilindungi dari hapus UI), kunci 1 proses, matikan scheduler sync selama restore, whitelist tabel + TRUNCATE idempoten per tabel.
- Bisa restore dari file server atau upload `.sql` langsung. Semua aksi tercatat di audit (`backup.create/upload/restore/delete`).

## WhatsApp nomor sendiri (scan QR)

- Pilih Provider `Nomor sendiri` di Pengaturan > Notifikasi, Simpan, klik Hubungkan, scan QR dari WhatsApp HP (Perangkat Tertaut). Sesi persisten di `storage/whatsapp-session` (di-gitignore). Restart server dulu setelah update kode agar route `/api/whatsapp` + kolom `phone` aktif.
- Semua kirim provider `self` antre FIFO: satu per satu + jeda acak + batas per menit/hari (anti-banned). Gagal self + gateway lengkap = fallback gateway otomatis.
- Broadcast: isi Nomor Penerima dengan koma (`62812xxxxxxx, 62813xxxxxxx`) atau klik `Pilih dari karyawan` (nomor HP karyawan, langsung tersimpan). Uji `Kirim uji` memakai nomor pertama bila banyak.

## Pengajuan & surat dinas

- Pengajuan cuti/izin/dinas + reimburse di menu Pengajuan (`/#/pengajuan`): tab pending/riwayat, filter status + rentang tanggal, impor/ekspor Excel.
- Dinas yang disetujui bisa dilengkapi transportasi + nomor surat (`PUT /api/employees/leaves/:id/travel`), lalu cetak Surat Perjalanan Dinas (`GET /api/employees/leaves/:id/travel-letter`). Tombol "Surat Dinas" / "Cetak Surat Dinas" muncul otomatis di riwayat + detail.
- Karyawan (`role employee`) mengajukan via Portal Saya + check-in dinas GPS + selfie (wajib lokasi + foto, check-out wajib selfie).
- GPS/kamera butuh secure context: di LAN `http://` browser memblokir geolokasi. Solusi: `chrome://flags > Insecure origins treated as secure > http://<ip-server>:3000 > Enabled > Relaunch`, atau pakai HTTPS. Fallback: isi Lat/Lng manual + upload file + peta Leaflet lokal.

## Laporan

Format (`GET /api/reports/formats`):

- `rekap_harian` — per karyawan per tanggal
- `rekap_bulanan` — per karyawan sebulan
- `per_karyawan` — ringkas Evaluasi Kinerja
- `lembur` — hanya yang lembur, urut terbanyak
- `rekap_kehadiran` — matriks hadir/telat/izin/alpa
- `ringkasan` — statistik per hari
- `log_mentah` — semua scan mesin

Preview JSON: `GET /api/reports/preview?format=rekap_harian&from=2026-10-01&to=2026-10-06`
Unduh Excel: `GET /api/reports/export/excel?...` (butuh `reports:export`; kolom harian `Durasi Kerja` berisi `8 jam 30 menit`)

## API ringkas

Semua butuh `Authorization: Bearer <jwt>` kecuali login & health. SSE stream pakai token via query (`/api/notifications/stream?token=`).

```
GET  /health
POST /api/auth/login
GET  /api/auth/me, /api/auth/meta
GET  /api/employees, /api/shifts, /api/holidays, /api/devices
GET  /api/master/departments, /api/master/positions   # data master untuk dropdown form karyawan
POST /api/master/departments | /api/master/positions   # {code, name} (butuh master:write)
PUT  /api/master/departments/:id | /api/master/positions/:id   # {name} saja, kode tidak bisa diubah
DELETE /api/master/departments/:id | /api/master/positions/:id # ditolak (409) bila masih dipakai karyawan
GET  /api/attendance/dashboard?days=14   # termasuk `calendar: {month, holidays, upcoming(60)}`
GET  /api/holidays?from=&to=   # sumber data kalender per bulan
GET  /api/devices/status
POST /api/devices/scheduler {enabled:true|false}   # hidup/mati auto-sync tanpa restart
POST /api/devices/:id/sync                         # 202 background + polling /devices/status
POST /api/devices/sync-all                          # 202 background
GET  /api/employees/leaves/history?status=all&from=&to=&limit=
GET  /api/employees/reimburses/history?status=all&from=&to=&limit=
PUT  /api/employees/leaves/:id/review               # {status, review_note, force, transport?, travel_letter_no?}
PUT  /api/employees/leaves/:id/travel               # {transport, travel_letter_no} (dinas approved)
GET  /api/employees/leaves/:id/travel-letter        # data surat siap cetak
GET  /api/employees/history/export/excel?tab=leave&status=all&from=&to=
GET  /api/reports/preview?format=rekap_harian&from=&to=&page=1&per_page=50   # pratinjau pagination, ekspor tetap full
GET  /api/notifications?unread=1&limit= | ?per_page=&page=   # bell = unread saja; halaman riwayat = pagination + meta
GET  /api/notifications/unread-count
GET  /api/whatsapp/self/status                      # sesi WA self + policy antrean (butuh notify:send)
POST /api/whatsapp/self/start | /stop | /logout     # Hubungkan/QR, Putuskan, hapus sesi
POST /api/whatsapp/self/test {target}               # target boleh 1 nomor; broadcast via Nomor Penerima (koma)
GET  /api/backup                                    # status + daftar file (admin)
POST /api/backup                                    # buat backup server (admin)
GET  /api/backup/download/:name                     # unduh .sql (admin)
POST /api/backup/upload (file)                      # upload .sql ke server (admin)
POST /api/backup/restore {name|file, confirm}       # restore, confirm = nama DB persis (admin)
DELETE /api/backup/:name                            # hapus file server, pra-restore dilindungi (admin)
GET  /api/notifications/stream?token=               # SSE (1 koneksi per user, lama ditutup otomatis)
GET  /api/geo/tiles/{z}/{x}/{y}.png, /api/geo/search?q=
GET  /api/attendance, /api/reports/preview, /api/audit, /api/me
```

## Data Master: Unit Kerja & Jabatan

Menu **Unit Kerja & Jabatan** (sidebar > Data Master) mengelola dua tabel referensi:

- **Unit Kerja** (divisi/departemen) — dipakai sebagai dropdown "Unit Kerja" di form karyawan, filter laporan/absensi, dan jadwal massal.
- **Jabatan** — dipakai sebagai dropdown "Jabatan" di form karyawan.

Aturan:
- **Kode unik & tidak bisa diubah** setelah dibuat (identitas historis). Hanya nama yang bisa diubah lewat tombol Ubah.
- **Hapus ditolak (409)** bila masih dipakai karyawan — kosongkan dulu di data karyawan terkait.
- Permission: `master:read` (semua role login) untuk melihat daftar, `master:write` (admin, hr) untuk tambah/ubah/hapus.
- Perubahan tercatat di audit log (`departments.create/update/delete`, `positions.*`).

Form karyawan membaca daftar ini dari `/api/auth/meta` dan **memuat ulang setiap kali halaman dibuka**, jadi dropdown selalu mengambil data terbaru dari server tanpa perlu logout.

## Seeder Data Dummy

| Perintah | Fungsi |
|---|---|
| `npm run seed` | Admin + 5 karyawan demo + shift/jadwal contoh (idempoten) |
| `node tools/seed-oktober.js` | Data dummy kehadiran 1–7 Oktober 2026: scan mentah mengikuti shift masing-masing karyawan (PAGI/SIANG/MALAM/FLEK), variasi telat/lembur/alpa, pengajuan izin/sakit/cuti/dinas, lalu rekap dihitung ulang. Idempoten — baris lama di periode yang sama dibersihkan dulu. |

Catatan seeder Oktober:
- Shift malam (23:00–07:00) ditulis sebagai check-in hari ini + check-out besok pagi. Karena `services/attendance.getLogsFor` menarik log pulang ke tanggal berikutnya, dua shift malam berurutan tidak bisa dipisahkan — seeder otomatis menjadwalkan **libur** pada hari setelah shift malam.
- Log di masa depan (mis. pulang shift malam hari ini) tidak ditulis.
- `tools/seed-dummy.js` (lama) masih ada dan tetap menghapus seluruh data absensi + memaksa jadwal global.

## Catatan Migrasi

`npm run migrate` **gagal di database kosong** pada versi sebelumnya: `src/db/upgrades.js` membuat tabel `notifications` dengan FK ke `app_users` sebelum `schema.sql` dijalankan, sehingga `app_users` belum ada dan MariaDB menolak dengan errno 150. Sudah diperbaiki — `upgradeNotifications` kini dilewati bila `app_users` belum ada (tabel dibuat oleh `schema.sql`).

Daftar lengkap: lihat `src/routes/*.js`.

## Stabilitas (anti-overload refresh)

- Auto-sync MATI default + kickoff 30 detik + sunyi saat idle (tanpa perangkat jatuh tempo).
- Dashboard query serial (1 koneksi bergantian), auth cache user 30 detik, `notify.status()` cache 30 detik.
- Pool DB: limit `20`, antrean `50` (langsung 503, bukan gantung), `connectTimeout` 5 detik.
- Server: `requestTimeout` 30 detik, SSE stream dikecualikan (`setTimeout(0)`) + max 1 koneksi per user.
- Frontend: boot kunci ganda, meta cache 60 detik, request GET sama didedupe (1 flight), dashboard batalkan request basi via `AbortController`, SSE lama ditutup dulu.
- Bila UI blank setelah spam refresh: hard refresh `Ctrl+Shift+R` sekali (muat JS baru), lalu refresh normal.

## Tools

`tools/cek-*.js` = skrip diagnosis (rekap libur, status alpa/belum, hari kerja, isi laporan). `tools/seed-dummy.js` = data dummy lokal.

## Produksi

1. `NODE_ENV=production`, `JWT_SECRET` acak >= 32 char
2. Ganti password `admin` (default `admin123`)
3. Batasi akses port `3001` hanya dari IP mesin
4. Jalankan di balik reverse proxy + backup DB rutin
5. Nyalakan auto-sync (`SYNC_ENABLED=true` / tombol Perangkat) hanya bila mesin stabil di LAN
