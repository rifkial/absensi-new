# Absensi Fingerprint

Aplikasi absensi fingerprint (Node.js + MySQL) dengan sinkronisasi otomatis dari mesin ZKTeco / PUSH.

Web UI + REST API di port `3000`, server PUSH/ADMS mesin di port `3001`.

## Fitur

- Karyawan, departemen, jabatan, shift, jadwal
- Tarik log otomatis dari mesin (polling) + mode PUSH (ADMS/icLock)
- Rekap harian/bulanan, telat, lembur, izin/sakit/cuti, alpa, hari libur
- Laporan 7 format + ekspor Excel
- Hari libur nasional (UI + sinkronisasi)
- Portal mandiri karyawan (`role employee`)
- Notifikasi email SMTP + WhatsApp gateway
- Audit log, throttle login, JWT auth
- Frontend statis di `public/` (tanpa build)

## Teknologi

Node.js >= 18, Express 4, MySQL 5.7+ / MariaDB 10.4+ (XAMPP), JWT, bcryptjs, dayjs, exceljs, multer, nodemailer.

## Struktur

```
src/server.js        # entry: 2 listener (web 3000 + PUSH 3001) + scheduler sync
src/app.js           # Express app, REST API, static frontend
src/config.js        # baca .env
src/db/              # pool, migrate, seed, upgrades
src/routes/          # auth, employees, shifts, holidays, devices, attendance, reports, settings, audit, me
src/services/        # attendance, reports, sync, notify, holidays
src/devices/         # adapter: zkteco-tcp, pushhttp, csv
src/middleware/      # auth (RBAC), error
db/schema.sql        # skema idempoten
public/              # UI statis (index.html, css/, js/pages/)
tools/               # probe, scan, sync-once, cek-*
test/                # node:test
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
| `DB_*` | host, port, user, password, nama DB |
| `JWT_SECRET` | wajib >= 32 karakter acak sebelum produksi |
| `TZ` | `Asia/Jakarta` (penting untuk shift & telat) |
| `SYNC_INTERVAL_MINUTES` | polling otomatis mesin |
| `DEVICE_TIMEOUT_MS` | timeout tarik log |
| `DEVICE_CLEAR_LOG_AFTER_SYNC` | `true` = hapus log di mesin setelah sync |
| `ATTENDANCE_CUTOFF_TIME`, `DEFAULT_LATE_TOLERANCE`, `MAX_DAILY_WORK_MINUTES` | aturan rekap |
| `MAIL_*` | SMTP (aktif bila `MAIL_ENABLED=true`) |
| `WHATSAPP_*` | gateway WA (aktif bila `WHATSAPP_ENABLED=true`) |
| `BACKFILL_DAYS` | backfill rekap saat generate |

## Script

| Perintah | Fungsi |
|---|---|
| `npm start` | jalan produksi |
| `npm run dev` | jalan + `--watch` |
| `npm run setup` | `migrate + seed` |
| `npm run migrate` | jalankan `db/schema.sql` (idempoten) |
| `npm run seed` | admin + departemen + jabatan + shift contoh |
| `npm run sync` | satu siklus sync lalu keluar (`--force`, `--days N`, `--device ID`) |
| `npm run probe -- <ip> [port] [pass]` | tes koneksi ke satu mesin |
| `npm run scan -- [prefix]` | pindai subnet cari mesin (contoh `192.168.1`) |
| `npm test` | `node --test test/**/*.test.js` |
| `npm run lint` | eslint |

## Peran & izin

Role: `admin`, `hr`, `operator`, `viewer`, `employee`.

- `employees:write`, `shifts:write`, `holidays:write` = admin, hr
- `devices:*`, `attendance:write` = admin, hr, operator
- `reports:read/export`, `attendance:read` = semua role login
- `settings`, `notify:send`, `audit:read`, `users:manage` = admin, hr
- `employee` = hanya data sendiri via `/api/me` + portal mandiri

## Mesin fingerprint

Protokol di `src/devices/`:

- `zkteco-tcp` — tarik via TCP port 4370 (default)
- `pushhttp` — mesin PUSH/ADMS ke `http://<ip-server>:3001/iclock/...`
- `csv` — impor file CSV

Alur: daftarkan mesin di menu Perangkat → tes koneksi → sync (otomatis per `SYNC_INTERVAL_MINUTES` atau manual / `npm run sync`). `device_user_id` (PIN mesin) harus cocok dengan data karyawan, yang tak cocok masuk log mentah `unmatched`.

Cek cepat dari terminal:

```bash
npm run probe -- 192.168.1.201
npm run probe -- 192.168.1.201 4370 0
npm run scan -- 192.168.1
```

Untuk mode PUSH, isi IP server + `PUSH_PORT` di menu ADMS mesin. Bila `PUSH_AUTH_TOKEN` diisi, mesin wajib kirim token sama.

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
Unduh Excel: `GET /api/reports/export/excel?...` (butuh `reports:export`)

## API ringkas

Semua butuh `Authorization: Bearer <jwt>` kecuali login & health.

```
GET  /health
POST /api/auth/login
GET  /api/employees, /api/shifts, /api/holidays, /api/devices
GET  /api/attendance, /api/reports/preview, /api/audit, /api/me
POST /api/devices/:id/sync
```

Daftar lengkap: lihat `src/routes/*.js`.

## Tools

`tools/cek-*.js` = skrip diagnosis (rekap libur, status alpa/belum, hari kerja, isi laporan). `tools/seed-dummy.js` = data dummy lokal.

## Produksi

1. `NODE_ENV=production`, `JWT_SECRET` acak >= 32 char
2. Ganti password `admin`
3. Batasi akses port `3001` hanya dari IP mesin
4. Jalankan di balik reverse proxy + backup DB rutin
