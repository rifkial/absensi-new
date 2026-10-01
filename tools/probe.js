'use strict';

/**
 * Probe konektivitas ke mesin fingerprint.
 *
 * Pakai:
 *   npm run probe -- 192.168.1.201
 *   npm run probe -- 192.168.1.201 4370
 *   npm run probe -- 192.168.1.201 4370 1234        (dengan password mesin)
 *
 * Alat ini mencoba:
 *   1. Port TCP terbuka?
 *   2. Protokol ZKTeco 4370 menjawab? (connect, versi firmware, jumlah user, jumlah log)
 *   3. Kalau gagal, TCP push port 4371 terbuka?
 */

const net = require('node:net');

const { ZkTcpClient } = require('../src/devices/zkteco4370/client');
const { getLocalAddressHint } = require('../src/devices/pushhttp/adapter');

const args = process.argv.slice(2);
const ip = args[0];
const port = Number.parseInt(args[1] ?? '4370', 10);
const password = Number.parseInt(args[2] ?? '0', 10);

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function log(symbol, color, message) {
  console.log(`${color}${symbol}${RESET} ${message}`);
}

function step(message) {
  console.log(`\n${CYAN}==> ${message}${RESET}`);
}

function checkPort(host, targetPort, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (open, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, detail });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.code || err.message));
    socket.connect(targetPort, host);
  });
}

function formatInfo(info) {
  if (!info) return null;
  const lines = [];
  if (info.firmwareVersion) lines.push(`  Firmware      : ${info.firmwareVersion}`);
  if (info.records !== null && info.records !== undefined) lines.push(`  Log tersimpan : ${info.records}`);
  if (info.users !== null && info.users !== undefined) lines.push(`  User terdaftar: ${info.users}`);
  if (info.fingers !== null && info.fingers !== undefined) lines.push(`  Sidik jari    : ${info.fingers}`);
  if (info.recordsCapacity) lines.push(`  Kapasitas log : ${info.recordsCapacity}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

async function main() {
  if (!ip) {
    console.log(`
${CYAN}Alat cek koneksi mesin fingerprint${RESET}

Pakai:
  node tools/probe.js <IP_MESIN> [PORT] [PASSWORD]

Contoh:
  node tools/probe.js 192.168.1.201
  node tools/probe.js 192.168.1.201 4370
  node tools/probe.js 192.168.1.201 4370 1234

Nilai default:
  PORT     = 4370 (port protokol ZKTeco Standalone SDK)
  PASSWORD = 0 (kosongkan bila mesin tidak dikunci password)

${YELLOW}Tip:${RESET} buka menu Comm/Network pada mesin untuk melihat IP & port yang terpasang.
`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PROBE MESIN: ${ip}:${port}`);
  console.log('='.repeat(60));

  // 1) Ping sederhana via TCP ke port aplikasi utama mesin (umumnya terbuka)
  step('1. Memeriksa port yang umum dipakai mesin');
  for (const p of [80, 4370, 4371, 8000, 8080]) {
    const result = await checkPort(ip, p, 1200);
    if (result.open) {
      log('[OK]', GREEN, `Port ${p} terbuka`);
    } else if (p === port) {
      log('[!]', YELLOW, `Port ${p} TIDAK terbuka (${result.detail})`);
    }
  }

  // 2) Uji protokol ZKTeco
  step(`2. Menguji protokol ZKTeco TCP pada port ${port}`);

  const client = new ZkTcpClient({ host: ip, port, timeout: 8000, password });

  try {
    await client.connect();
    log('[OK]', GREEN, 'Mesin menerima koneksi dan memberi session id.');

    const firmware = await client.getFirmwareVersion().catch(() => null);
    if (firmware) {
      log('[OK]', GREEN, `Versi firmware: ${firmware}`);
    } else {
      log('[!]', YELLOW, 'Firmware tidak bisa dibaca (tidak kritikal).');
    }

    const info = await client.getInfo().catch(() => null);
    const infoText = formatInfo(info);
    if (infoText) {
      console.log(infoText);
    } else {
      log('[!]', YELLOW, 'Informasi kapasitas tidak bisa dibaca (tidak kritikal).');
    }

    // 3) Coba tarik log
    step('3. Mencoba menarik log absensi');
    const started = Date.now();
    const logs = await client.getAttendanceLogs();
    const elapsed = Date.now() - started;

    log('[OK]', GREEN, `${logs.length} baris log berhasil ditarik dalam ${elapsed}ms.`);

    if (logs.length > 0) {
      console.log(`\n${DIM}  Contoh 5 log terakhir:${RESET}`);
      for (const entry of logs.slice(-5)) {
        const t = entry.logTime;
        const pad = (n) => String(n).padStart(2, '0');
        const time = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
        console.log(`    PIN ${String(entry.deviceUserId).padEnd(12)} ${time}  (format waktu: ${entry.timeFormat})`);
      }
      console.log(`\n${DIM}  PIN di atas harus sama dengan device_user_id di menu Karyawan.${RESET}`);
    } else {
      log('[!]', YELLOW, 'Mesin tidak punya log. Silakan lakukan scan di mesin lalu probe ulang.');
    }

    // 4) Cek daftar user
    step('4. Membaca daftar user di mesin');
    const users = await client.getUsers().catch(() => null);
    if (users) {
      log('[OK]', GREEN, `${users.length} user terdaftar di mesin.`);
      if (users.length > 0) {
        console.log(`\n${DIM}  Contoh 5 user:${RESET}`);
        for (const user of users.slice(0, 5)) {
          console.log(`    UID ${String(user.uid).padEnd(5)} PIN ${String(user.deviceUserId).padEnd(12)} ${user.name}`);
        }
        console.log(`\n${DIM}  Cocokkan PIN dengan kolom device_user_id di master karyawan.${RESET}`);
      }
    }

    console.log(`\n${GREEN}${'-'.repeat(60)}${RESET}`);
    console.log(`${GREEN}  HASIL: MESIN TERDETEKSI DAN SIAP DIPAKAI${RESET}`);
    console.log(`${GREEN}${'-'.repeat(60)}${RESET}`);
    console.log(`
Langkah selanjutnya:
  1. Buka aplikasi di http://localhost:3000
  2. Masuk sebagai admin / admin123
  3. Menu "Perangkat" -> Tambah -> isi:
       Nama         : ${ip}
       Protokol     : ZKTeco TCP (port 4370)
       Alamat IP    : ${ip}
       Port         : ${port}
  4. Klik "Uji Koneksi", lalu "Sinkron Sekarang"

${DIM}Untuk mesin mode PUSH/ADMS, isi IP server ini: ${getLocalAddressHint()}${RESET}
`);
  } catch (err) {
    log('[X]', RED, `Gagal: ${err.message}`);

    console.log(`\n${YELLOW}Kemungkinan penyebab:${RESET}`);
    console.log('  - IP salah, atau komputer & mesin tidak di jaringan yang sama');
    console.log('  - Kabel LAN belum terpasang / belum diaktifkan di mesin');
    console.log('  - Firewall Windows memblokir koneksi keluar');
    console.log('  - Mesin sedang dipakai aplikasi lain (mis.\ZKTeco Software) sehingga port terkunci');
    console.log('  - Memerlukan password koneksi');
    console.log('  - Menu "Comm" pada mesin harus diset ke mode "Ethernet" bukan "USB"');
    console.log(`\n${DIM}Uji cepat konektivitas dari PowerShell:${RESET}`);
    console.log(`  Test-NetConnection -ComputerName ${ip} -Port ${port}`);

    process.exitCode = 1;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[probe] Error tidak terduga:', err);
  process.exit(1);
});
