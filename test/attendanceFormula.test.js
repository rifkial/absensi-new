'use strict';

/**
 * Menjamin rumus kehadiran dan hitungan hari kerja selalu konsisten.
 *
 * Aturan yang dijaga:
 *   - total_hari_kerja  = semua status KECUALI hari_libur
 *   - total_kehadiran   = hadir + telat + dinas_luar + dinas_dalam + cuti
 *   - selisih keduanya harus PERSIS sama dengan izin+sakit+alpa+belum
 *
 * Uji terakhir inilah yang menangkap bug dinas_dalam: status itu masuk hitungan
 * hari kerja tapi sempat tidak ada di rumus kehadiran, sehingga diam-diam
 * memotong persentase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const attendance = require('../src/services/attendance');

const num = (v) => Number(v || 0);

/** Status yang boleh dihitung sebagai kehadiran. */
const ATTENDANCE_STATUSES = [
  'hadir',
  'telat',
  'dinas_luar',
  'dinas_dalam',
  'cuti',
];

/** Status yang memotong kehadiran (tidak menambah, tapi tetap hari kerja). */
const DEDUCT_STATUSES = ['izin', 'sakit', 'alpa', 'belum'];

/** Bangun rekap dari daftar hari, lalu cek konsistensinya. */
function rekap(perStatus) {
  const totalHariKerja = ATTENDANCE_STATUSES.concat(DEDUCT_STATUSES)
    .reduce((sum, s) => sum + (perStatus[s] || 0), 0);
  const kehadiran = ATTENDANCE_STATUSES
    .reduce((sum, s) => sum + (perStatus[s] || 0), 0);
  const pemotong = DEDUCT_STATUSES
    .reduce((sum, s) => sum + (perStatus[s] || 0), 0);

  return {
    total_hari_kerja: totalHariKerja,
    total_kehadiran: kehadiran,
    pemotong,
    persen: totalHariKerja > 0 ? Math.round((kehadiran / totalHariKerja) * 100) : 0,
  };
}

test('hari kerja = semua status kecuali hari libur', () => {
  const r = rekap({ hadir: 14, telat: 3, dinas_luar: 2, cuti: 1, alpa: 2 });
  // 14 + 3 + 2 + 1 + 2 = 22; hari libur tidak dihitung.
  assert.equal(r.total_hari_kerja, 22);
});

test('kehadiran = hadir + telat + dinas luar + dinas dalam + cuti', () => {
  const r = rekap({ hadir: 14, telat: 3, dinas_luar: 2, cuti: 1, alpa: 2 });
  assert.equal(r.total_kehadiran, 20);
  assert.equal(r.persen, 91);
});

test('cuti tidak memotong kehadiran', () => {
  // Pegawai sama, dua hari cuti diganti izin. Karena cuti menambah kehadiran
  // dan izin tidak, selisihnya harus 2 poin persentase.
  const denganCuti = rekap({ hadir: 14, telat: 3, dinas_luar: 2, cuti: 2, alpa: 2 });
  const denganIzin = rekap({ hadir: 14, telat: 3, dinas_luar: 2, izin: 2, alpa: 2 });

  assert.equal(denganCuti.total_hari_kerja, denganIzin.total_hari_kerja);
  assert.equal(denganCuti.total_kehadiran, denganIzin.total_kehadiran + 2);
  assert.ok(
    denganCuti.persen > denganIzin.persen,
    `cuti harus memberi persentase lebih tinggi (${denganCuti.persen}% vs ${denganIzin.persen}%)`
  );
});

test('dinas dalam kota dihitung sebagai kehadiran', () => {
  // Ini bug yang pernah ada: dinas_dalam masuk hari kerja tapi tidak masuk
  // rumus kehadiran, sehingga memotong persentase tanpa jejak.
  const r = rekap({ hadir: 14, telat: 3, dinas_luar: 0, dinas_dalam: 1, cuti: 2, alpa: 2 });
  assert.equal(r.total_hari_kerja, 22);
  assert.equal(r.total_kehadiran, 20);
});

test('selisih hari kerja dan kehadiran = izin + sakit + alpa + belum', () => {
  const kasus = [
    { hadir: 14, telat: 3, dinas_dalam: 1, cuti: 2, alpa: 2 },
    { hadir: 13, telat: 7, izin: 1, alpa: 1 },
    { hadir: 17, telat: 3, sakit: 2 },
    { hadir: 10, dinas_luar: 5, dinas_dalam: 3, cuti: 4, izin: 2, sakit: 1, alpa: 1 },
    { belum: 5 },
  ];

  for (const perStatus of kasus) {
    const r = rekap(perStatus);
    const selisih = r.total_hari_kerja - r.total_kehadiran;
    assert.equal(
      selisih,
      r.pemotong,
      `tidak konsisten untuk ${JSON.stringify(perStatus)}`
    );
  }
});

test('daftar status kehadiran mencakup semua ATTENDED_STATUSES', () => {
  // Kalau attendance.js menambah status baru (mis. 'dinas_malam'), rumus
  // laporan harus ikut menambahkannya, kalau tidak ia akan memotong kehadiran.
  for (const status of attendance.ATTENDED_STATUSES) {
    assert.ok(
      ATTENDANCE_STATUSES.includes(status),
      `status "${status}" ada di ATTENDED_STATUSES tapi tidak di rumus kehadiran laporan`
    );
  }
});