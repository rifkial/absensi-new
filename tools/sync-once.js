'use strict';

/**
 * Jalankan satu siklus sinkronisasi mesin lalu keluar.
 *
 * Berguna untuk:
 *   - Testing dari terminal, tanpa harus menjalankan server.
 *   - Cron Windows / Task Scheduler.
 *   - Memeriksa apakah mesin bisa ditarik log-nya.
 *
 * Pakai:
 *   npm run sync
 *   npm run sync -- --force          (abaikan interval per perangkat)
 *   npm run sync -- --days 7         (hitung ulang rekap 7 hari terakhir)
 *   npm run sync -- --device 3       (hanya perangkat dengan id 3)
 *
 * Penjadwal otomatis di dalam server TIDAK dijalankan oleh skrip ini, jadi
 * aman dipakai bersamaan dengan server yang sedang berjalan: `runCycle`
 * memakai lock sehingga siklus yang tumpang tindih akan dilewati.
 */

const db = require('../src/db/pool');
const sync = require('../src/services/sync');

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function parseArgs(argv) {
  const options = { force: false, days: 1, device: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--days' || arg === '-d') {
      options.days = Math.max(1, Math.min(60, Number(argv[i + 1]) || 1));
      i += 1;
    } else if (arg === '--device' || arg === '-D') {
      options.device = Number(argv[i + 1]) || null;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function usage() {
  console.log(`
Pakai:
  npm run sync
  npm run sync -- --force        abaikan interval per perangkat
  npm run sync -- --days 7       hitung ulang rekap 7 hari terakhir
  npm run sync -- --device 3     hanya perangkat dengan id 3
`);
}

function line(symbol, color, message) {
  console.log(`${color}${symbol}${RESET} ${message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  console.log(`${CYAN}${'='.repeat(60)}${RESET}`);
  console.log(`${CYAN}  SINKRONISASI SATU SIKLUS${RESET}`);
  console.log(`${CYAN}${'='.repeat(60)}${RESET}`);

  const devices = await sync.getSyncableDevices();
  if (devices.length === 0) {
    line('!', YELLOW, 'Tidak ada perangkat aktif dengan auto_sync = 1.');
    console.log('  Tambahkan mesin di menu Perangkat, atau nyalakan auto_sync.');
    return;
  }

  console.log(`  Perangkat aktif : ${devices.length}`);
  console.log(`  Mode            : ${options.force ? 'paksa (abaikan interval)' : 'hanya yang sudah waktunya'}`);
  console.log(`  Rekap           : ${options.days} hari terakhir`);
  console.log(`${CYAN}${'='.repeat(60)}${RESET}\n`);

  const summary = await sync.runCycle({
    only: options.device,
    force: options.force || Boolean(options.device),
    regenerateDays: options.days,
  });

  if (summary.skipped) {
    line('!', YELLOW, summary.message);
    return;
  }

  console.log('');
  for (const device of summary.devices) {
    const mark = device.ok ? `${GREEN}OK  ${RESET}` : `${RED}GAGAL${RESET}`;
    console.log(
      `  ${mark} ${device.name} (${device.protocol}) - ` +
      `baru: ${device.inserted || 0}, duplikat: ${device.duplicated || 0}, ` +
      `tanpa karyawan: ${device.unmatched || 0}`
    );
    if (!device.ok && device.message) {
      console.log(`        ${RED}${device.message}${RESET}`);
    }
  }

  console.log('');
  console.log(`  Total log baru     : ${summary.inserted}`);
  console.log(`  Total duplikat     : ${summary.duplicated}`);
  console.log(`  Log tanpa karyawan : ${summary.unmatched}`);
  console.log(`  Perangkat gagal    : ${summary.failed}`);
  if (summary.regenerated) {
    console.log(`  Rekap dihitung     : ${summary.regenerated.processed} baris`);
  }
  console.log(`  Durasi             : ${summary.duration_ms} ms`);

  if (summary.error) {
    line('X', RED, `Siklus gagal: ${summary.error}`);
  }

  const semuaOk = summary.failed === 0 && !summary.error;
  console.log('');
  line(
    semuaOk ? 'OK' : 'X',
    semuaOk ? GREEN : RED,
    semuaOk ? 'Sinkronisasi selesai.' : 'Sinkronisasi selesai dengan catatan.'
  );
}

main()
  .catch((err) => {
    console.error(`${RED}[sync-once] GAGAL:${RESET} ${err.message}`);
    console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.closePool().catch(() => {});
  });
