'use strict';

/**
 * Tes logika jatah cuti tahunan (bagian murni, tanpa database).
 *
 * Fungsi yang diuji di sini menentukan berapa hari yang dipotong dari jatah,
 * jadi salah di sini berarti karyawan kehilangan ataudobleh hak cuti.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { countQuotaDays, usesQuota, QUOTA_SUBTYPE } = require('../src/services/leaveQuota');
const leaveCatalog = require('../src/services/leaveCatalog');

// 2026-03-01=Minggu, 02=Senin ... 06=Jumat, 07=Sabtu, 08=Minggu.
const SENIN_KE_JUMAT = '1,2,3,4,5';

test('countQuotaDays menghitung hari kerja dalam rentang', () => {
  // Senin 02 sampai Kamis 05 = 4 hari kerja.
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-02', '2026-03-05'), 4);
});

test('countQuotaDays melewati akhir pekan', () => {
  // Jumat 06 sampai Senin 09 = hanya Jumat dan Senin = 2 hari kerja.
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-06', '2026-03-09'), 2);
});

test('countQuotaDays rentang akhir pekan saja bernilai nol', () => {
  // Sabtu 07 sampai Minggu 08 tidak ada hari kerja.
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-07', '2026-03-08'), 0);
});

test('countQuotaDays satu hari kerja bernilai satu', () => {
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-02', '2026-03-02'), 1);
});

test('countQuotaDays tanpa daftar hari kerja menghitung semua hari kecuali Minggu', () => {
  // Tanpa shift, semua hari dalam rentang dianggap hari kerja. Tapi Minggu
  // (2026-03-08) tidak pernah dihitung, sehingga 06-08 = Jumat + Sabtu = 2.
  assert.equal(countQuotaDays(null, '2026-03-06', '2026-03-08'), 2);
  // Rentang yang seluruhnya Minggu tidak memotong jatah sama sekali.
  assert.equal(countQuotaDays(null, '2026-03-08', '2026-03-08'), 0);
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-08', '2026-03-08'), 0);
});

test('countQuotaDays mengabaikan work_days lama yang memuat Minggu', () => {
  // Instalasi lama bisa punya work_days "1,2,3,4,5,7"; Minggu di dalamnya
  // harus tetap diabaikan supaya jatah cuti tidak berkurang karena Minggu.
  const lamaDenganMinggu = '1,2,3,4,5,7';
  assert.equal(countQuotaDays(lamaDenganMinggu, '2026-03-06', '2026-03-08'), 1);
  assert.equal(countQuotaDays(lamaDenganMinggu, '2026-03-02', '2026-03-08'), 5);
});

test('countQuotaDays menghormati shift 6 hari kerja', () => {
  const enamHari = '1,2,3,4,5,6'; // Senin-Sabtu
  // Jumat 06 sampai Senin 09 = Jumat, Sabtu, Senin = 3.
  assert.equal(countQuotaDays(enamHari, '2026-03-06', '2026-03-09'), 3);
});

test('countQuotaDays menolak tanggal terbalik', () => {
  assert.equal(countQuotaDays(SENIN_KE_JUMAT, '2026-03-09', '2026-03-02'), 0);
});

test('usesQuota hanya berlaku untuk cuti tahunan', () => {
  assert.equal(usesQuota({ leave_type: 'cuti', subtype: QUOTA_SUBTYPE }), true);
});

test('jenis cuti lain tidak memakai jatah tahunan', () => {
  for (const subtype of [
    'cuti_melahirkan',
    'cuti_menikah',
    'cuti_haji',
    'cuti_kematian_keluarga',
    'cuti_alasan_penting',
    'cuti_tanpa_bayar',
    'cuti_lainnya',
  ]) {
    assert.equal(usesQuota({ leave_type: 'cuti', subtype }), false, `${subtype} tidak boleh potong jatah`);
  }
});

test('izin dan dinas tidak memakai jatah cuti tahunan', () => {
  assert.equal(usesQuota({ leave_type: 'izin', subtype: 'izin_tidak_masuk' }), false);
  assert.equal(usesQuota({ leave_type: 'sakit', subtype: 'izin_sakit' }), false);
  assert.equal(usesQuota({ leave_type: 'dinas_luar', subtype: 'dinas_luar_kota' }), false);
  assert.equal(usesQuota({ leave_type: 'dinas_dalam', subtype: 'dinas_dalam_kota' }), false);
});

test('pengajuan lama tanpa subtype: hanya leave_type cuti yang memakai jatah', () => {
  // Data lama belum punya subtype, jadi harus seguras: izin tidak boleh
  // ikut memotong jatah cuti tahunan.
  assert.equal(usesQuota({ leave_type: 'cuti', subtype: null }), true);
  assert.equal(usesQuota({ leave_type: 'izin', subtype: null }), false);
  assert.equal(usesQuota({ leave_type: 'sakit', subtype: null }), false);
});

test('usesQuota aman untuk input kosong', () => {
  assert.equal(usesQuota(null), false);
  assert.equal(usesQuota(undefined), false);
});

test('katalog tetap memetakan cuti tahunan ke status cuti', () => {
  assert.equal(leaveCatalog.statusForLeave('cuti', 'cuti_tahunan'), 'cuti');
});

test('katalog tidak lagi punya sub-jenis sakit', () => {
  // Kondisi sakit diinput sebagai izin biasa, jadi tidak ada jalur yang
  // menghasilkan status 'sakit' lagi.
  assert.equal(leaveCatalog.findSubtype('cuti_sakit'), null);
  assert.equal(leaveCatalog.findSubtype('izin_sakit'), null);
  assert.equal(leaveCatalog.LEAVE_TYPES.includes('sakit'), false);
});

test('leave_type sakit lama dipetakan ke status izin', () => {
  // Pengajuan yang sudah tersimpan sebelum sub-jenis dihapus harus tetap
  // terbaca sebagai izin, bukan status 'sakit' yang tak terpakai lagi.
  assert.equal(leaveCatalog.statusForLeave('sakit', null), 'izin');
  assert.equal(leaveCatalog.statusForLeave('cuti', 'cuti_sakit'), 'izin');
});

test('countQuotaDays mengikuti work_days dari shift karyawan', () => {
  // Karyawan dengan shift Senin-Kamis: cuti 5 hari kalender = 4 hari kerja.
  const hasil = countQuotaDays('1,2,3,4', '2026-03-02', '2026-03-06');
  assert.equal(hasil, 4);
});
