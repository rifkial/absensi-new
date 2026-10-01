'use strict';

/**
 * Pindai subnet lokal untuk mencari mesin fingerprint.
 *
 * Pakai:
 *   npm run scan
 *   npm run scan -- 192.168.1
 *
 * Port yang diperiksa: 4370 (ZKTeco TCP), 4371, 80, 8080, 7000, 8000.
 * Untuk setiap port 4370 yang terbuka, protokol ZKTeco langsung dicoba.
 */

const net = require('node:net');
const os = require('node:os');

const { ZkTcpClient } = require('../src/devices/zkteco4370/client');
const { getLocalAddressHint } = require('../src/devices/pushhttp/adapter');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PORTS = [4370, 4371, 80, 8080, 7000, 8000];
const CONCURRENCY = 200;
const TIMEOUT_MS = 500;

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Batasi jumlah koneksi bersamaan supaya tidak membanjiri jaringan. */
async function limitedMap(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function localSubnets() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (/^169\.254\./.test(addr.address)) continue;
      const parts = addr.address.split('.');
      if (parts.length !== 4) continue;
      out.push({ interface: name, subnet: parts.slice(0, 3).join('.'), address: addr.address });
    }
  }
  return out;
}

async function main() {
  const argSubnet = process.argv[2];

  console.log(`\n${'='.repeat(60)}`);
  console.log('  PINDAI MESIN FINGERPRINT DI JARINGAN LOKAL');
  console.log('='.repeat(60));

  let subnets;
  if (argSubnet) {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(argSubnet)) {
      console.error(`${RED}Subnet harus format "192.168.1" (tanpa octet terakhir).${RESET}`);
      process.exit(1);
    }
    subnets = [{ interface: 'dari argumen', subnet: argSubnet, address: `${argSubnet}.x` }];
  } else {
    subnets = localSubnets();
    if (subnets.length === 0) {
      console.error(`${RED}Tidak ada interface IPv4 aktif (selain loopback).${RESET}`);
      console.error('Sambungkan kabel LAN atau hubungkan ke Wi-Fi dulu.');
      process.exit(1);
    }
  }

  console.log(`\n${CYAN}Subnet yang akan dipindai:${RESET}`);
  for (const s of subnets) {
    console.log(`  ${s.subnet}.0/24  (via ${s.interface})`);
  }
  console.log(`${DIM}Port: ${PORTS.join(', ')}${RESET}`);

  // 1) Cek semua IP di semua subnet
  const targets = [];
  for (const s of subnets) {
    for (let host = 1; host <= 254; host += 1) {
      for (const port of PORTS) {
        targets.push({ ip: `${s.subnet}.${host}`, port, subnet: s.subnet });
      }
    }
  }

  console.log(`\n${DIM}Memindai ${targets.length} kombinasi IP:port...${RESET}\n`);

  let scanned = 0;
  const open = [];
  await limitedMap(targets, CONCURRENCY, async (target) => {
    scanned += 1;
    if (scanned % 500 === 0) {
      process.stdout.write(`\r${DIM}  ${scanned}/${targets.length} (${open.length} port terbuka)${RESET}`);
    }
    const isOpen = await checkPort(target.ip, target.port);
    if (isOpen) open.push(target);
    return isOpen;
  });

  process.stdout.write(`\r${DIM}  ${scanned}/${targets.length} selesai              ${RESET}\n`);

  if (open.length === 0) {
    console.log(`\n${YELLOW}Tidak ada port terbuka yang terdeteksi.${RESET}`);
    console.log('Kemungkinan penyebab:');
    console.log('  - Komputer dan mesin tidak di subnet yang sama');
    console.log('  - Jaringan butuh waktu untuk converge, coba ulangi');
    console.log('  - Firewall memblokir');
    console.log('  - Mesin sedang mati');
    return;
  }

  // 2) Uji protokol pada kandidat 4370
  const zkCandidates = open.filter((o) => o.port === 4370);
  console.log(`\n${CYAN}Hasil:${RESET}`);
  console.log(`  Total port terbuka: ${open.length}`);
  console.log(`  Kandidat mesin (port 4370): ${zkCandidates.length}`);

  if (zkCandidates.length > 0) {
    console.log(`\n${CYAN}Mencoba protokol ZKTeco:${RESET}\n`);
    for (const candidate of zkCandidates) {
      const client = new ZkTcpClient({ host: candidate.ip, port: 4370, timeout: 4000 });
      try {
        await client.connect();
        const firmware = await client.getFirmwareVersion().catch(() => null);
        const info = await client.getInfo().catch(() => ({}));
        console.log(`  ${GREEN}[MESIN DITEMUKAN]${RESET} ${candidate.ip}:4370`);
        console.log(`    Firmware : ${firmware || 'tidak terbaca'}`);
        console.log(`    User     : ${info.users ?? '-'} | Log: ${info.records ?? '-'} | Sidik jari: ${info.fingers ?? '-'}`);
        console.log('');
      } catch (err) {
        console.log(`  ${RED}[GAGAL]${RESET} ${candidate.ip}:4370 - ${err.message}`);
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
  }

  // 3) Tampilkan port lain yang terbuka
  const others = open.filter((o) => o.port !== 4370);
  if (others.length > 0) {
    console.log(`${CYAN}Port lain yang terbuka:${RESET}`);
    const grouped = new Map();
    for (const item of others) {
      if (!grouped.has(item.ip)) grouped.set(item.ip, []);
      grouped.get(item.ip).push(item.port);
    }
    for (const [ip, ports] of grouped) {
      console.log(`  ${ip}  ->  ${ports.join(', ')}`);
    }
    console.log(`\n${DIM}Port 4371/80/8080 bisa berarti mesin berjalan mode PUSH atau antarmuka web.${RESET}`);
  }

  console.log(`
${DIM}Untuk mesin yang tidak ditemukan, periksa:${RESET}
  - Menu Comm/Network di mesin: sudah Ethernet? IP sudah benar?
  - Firewall Windows: izinkan Node.js lewat inbound/outbound
  - Kabel LAN menyala (LED di port mesin)
  - Mesin tidak sedang dipakai software vendor lain

${DIM}Uji manual satu mesin:${RESET}
  npm run probe -- <IP>

${DIM}Untuk mesin mode PUSH/ADMS, arahkan mesin ke IP server: ${getLocalAddressHint()}${RESET}
`);
}

main().catch((err) => {
  console.error('[scan] Error:', err);
  process.exit(1);
});
