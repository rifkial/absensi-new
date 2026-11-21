'use strict';

const config = require('../config');

/**
 * Katalog model mesin fingerprint yang sudah dikenal.
 *
 * Dipakai form "Tambah Perangkat" sebagai preset: memilih model akan mengisi
 * protokol & port otomatis sehingga mengurangi salah konfigurasi. Tambah entri
 * baru di sini saat ada merek/model lain yang umum dipakai.
 *
 * `protocol` wajib salah satu protokol adapter yang terdaftar (lihat
 * src/devices/index.js). `also_supports` = protokol alternatif yang bisa dipilih.
 */
const MODELS = [
  {
    id: 'generic-zkteco',
    brand: 'Umum',
    model: 'ZKTeco-compatible',
    protocol: 'zkteco-tcp',
    port: 4370,
    connection: 'TCP/IP',
    notes: 'Pilih ini bila model mesin tidak ada di daftar. Protokol biner ZKTeco port 4370.',
  },
  {
    id: 'fingerspot-all-series',
    brand: 'Fingerspot',
    model: 'All Series',
    protocol: 'zkteco-tcp',
    port: 4370,
    connection: 'WiFi / TCP/IP / USB / Flashdisk',
    notes:
      'Semua seri Fingerspot (Revo, Solution, X-Series, Neos, dsb) kompatibel ZKTeco. ' +
      'Tarik via TCP 4370 atau mode PUSH/ADMS ke server ini.',
    also_supports: ['push-http', 'fkweb-http'],
    // Panduan pengaturan di sisi MESIN (bukan di aplikasi ini).
    setup: [
      {
        title: 'Cara 1 - TCP/IP (direkomendasikan: server menarik data dari mesin)',
        steps: [
          'Di mesin: Menu > Komunikasi (Comm) / Network > Ethernet / Pengaturan Jaringan.',
          'IP Address: satu subnet dengan server (mis. 192.168.1.201), Subnet Mask: 255.255.255.0, Gateway: 192.168.1.1.',
          'Port / Comm Port: 4370 (biarkan default). Device ID: 1.',
          'Simpan, lalu restart mesin. Di aplikasi ini pilih protokol "ZKTeco TCP (port 4370)".',
        ],
      },
      {
        title: 'Cara 2 - PUSH / ADMS (mesin yang mengirim log ke server)',
        steps: [
          'Di mesin: Menu > Cloud Server / ADMS / Server Setting (bila tersedia di seri ini).',
          'Server Address: IP komputer server ini, Server Port: 3001, Enable Domain Name: Off.',
          'Simpan, lalu restart mesin. Di aplikasi ini pilih protokol "PUSH HTTP (ADMS)" - SN terisi otomatis.',
        ],
      },
      {
        title: 'Koneksi WiFi',
        steps: [
          'Di mesin: Menu > Network > WiFi, pilih SSID lalu masukkan password.',
          'Jarak mesin ke router disarankan maksimal 5 meter; lebih dari itu pakai kabel LAN atau WiFi repeater.',
        ],
      },
      {
        title: 'Catatan',
        steps: [
          'Pilih salah satu mode saja (TCP atau PUSH), jangan dua-duanya sekaligus.',
          'Untuk mode PUSH, pastikan firewall server mengizinkan port 3001.',
          'PIN karyawan di mesin harus sama dengan kolom "PIN Mesin" di data karyawan.',
          'Bila seri lama tanpa menu ADMS / Cloud, pakai Cara 1 (TCP) atau unduh log via USB lalu impor menu Impor File.',
        ],
      },
    ],
  },
  {
    id: 'fingerspot-revo-wfv-208bnc',
    brand: 'Fingerspot',
    model: 'Revo WFV-208BNC+',
    protocol: 'fkweb-http',
    port: config.server.fkwebPort,
    connection: 'WiFi / Internet (FkWeb)',
    notes:
      'Revo WFV-208BNC+ memakai mode Internet/FkWeb: mesin mengirim absensi ke server. ' +
      'PIN mesin harus sama dengan PIN Mesin karyawan.',
    setup: [
      {
        title: 'Setting di mesin (mode Internet / FkWeb)',
        steps: [
          'Di mesin: Menu > Jaringan / Network.',
          'Mode: Internet (bukan Lokal).',
          'Server IP: IP komputer server ini (lihat petunjuk di halaman Perangkat).',
          `Server Port: ${config.server.fkwebPort}.`,
          'Server Req: Ya.',
          'Simpan, lalu restart mesin bila perlu.',
        ],
      },
      {
        title: 'Setting di aplikasi',
        steps: [
          'Tambah Perangkat, pilih model "Fingerspot Revo WFV-208BNC+".',
          `Protokol otomatis "Fingerspot FkWeb (Internet)", port ${config.server.fkwebPort}.`,
          'Serial Number / Cloud ID boleh dikosongkan; terisi otomatis saat mesin terhubung.',
          'Pastikan PIN karyawan di mesin sama dengan kolom "PIN Mesin" di data karyawan.',
        ],
      },
      {
        title: 'Catatan',
        steps: [
          `FkWeb tidak memakai autentikasi. Batasi port ${config.server.fkwebPort} lewat firewall/LAN.`,
          'Server dan mesin harus bisa saling menjangkau (satu jaringan atau VPN).',
          'Mesin mengirim log lama yang belum pernah dijawab OK; data duplikat diabaikan.',
        ],
      },
    ],
  },
  {
    id: 'solution-all-series',
    brand: 'Solution',
    model: 'All Series',
    protocol: 'zkteco-tcp',
    port: 4370,
    connection: 'TCP/IP / USB / Flashdisk',
    notes:
      'Semua seri Solution (X-Series / P-Series / dsb) kompatibel ZKTeco. ' +
      'Tarik via TCP 4370 atau mode PUSH/ADMS ke server ini.',
    also_supports: ['push-http'],
    setup: [
      {
        title: 'Cara 1 - TCP/IP (direkomendasikan: server menarik data dari mesin)',
        steps: [
          'Di mesin: Menu > Setting / Pengaturan > Jaringan / Network / Comm.',
          'IP Address: satu subnet dengan server (mis. 192.168.1.202), Subnet Mask: 255.255.255.0, Gateway: 192.168.1.1.',
          'Port / Comm Port: 4370 (biarkan default). Device ID: 1.',
          'Simpan, lalu restart mesin. Di aplikasi ini pilih protokol "ZKTeco TCP (port 4370)".',
        ],
      },
      {
        title: 'Cara 2 - PUSH / ADMS (mesin yang mengirim log ke server)',
        steps: [
          'Di mesin: Menu > Setting > Cloud Server / ADMS / Server Setting (bila tersedia di seri ini).',
          'Server Address: IP komputer server ini, Server Port: 3001, Enable Domain Name: Off.',
          'Simpan, lalu restart mesin. Di aplikasi ini pilih protokol "PUSH HTTP (ADMS)" - SN terisi otomatis.',
        ],
      },
      {
        title: 'Catatan',
        steps: [
          'Pilih salah satu mode saja (TCP atau PUSH), jangan dua-duanya sekaligus.',
          'Untuk mode PUSH, pastikan firewall server mengizinkan port 3001.',
          'PIN karyawan di mesin harus sama dengan kolom "PIN Mesin" di data karyawan.',
          'Bila seri lama tanpa menu ADMS / Cloud, pakai Cara 1 (TCP) atau unduh log via USB lalu impor menu Impor File.',
        ],
      },
    ],
  },
];

/** Port default per protokol, untuk mengisi form saat protokol berganti. */
function defaultPort(protocol) {
  if (protocol === 'zkteco-tcp') return 4370;
  if (protocol === 'push-http') return 3001;
  if (protocol === 'fkweb-http') return config.server.fkwebPort;
  return 0;
}

function listModels() {
  return MODELS.map((model) => ({ ...model }));
}

module.exports = { MODELS, listModels, defaultPort };
