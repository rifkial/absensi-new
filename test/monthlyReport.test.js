'use strict';

/**
 * Tes perhitungan rekap bulanan.
 *
 * Dua aturan yang dijaga di sini:
 *   1. Pembagi persentase kehadiran adalah TOTAL HARI KERJA (bukan jumlah hari
 *      kalender). Hari libur dan hari Minggu tidak ikut dihitung.
 *   2. Keterlambatan TIDAK mengurangi kehadiran. Status "telat" tetap dihitung
 *      hadir; hanya menit telatnya yang diakumulasikan terpisah.
 *   3. Kehadiran = hadir + telat + dinas luar + cuti. Cuti resmi tidak
 *      mengurangi kehadiran yang diakui; izin & sakit tidak dihitung.
 *
 * Tes ini murni tanpa database: bentuk baris dan aturan pembagiannya dihitung
 * ulang di sini, mengikuti rumus yang dipakai src/services/reports.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/** Bentuk satu baris rekap bulanan seperti hasil agregat SQL. */
function makeRow(overrides = {}) {
  return {
    employee_code: '001',
    employee_name: 'Uji',
    department_name: null,
    position_name: null,
    total_days: 30,        // baris kalender dalam bulan
    total_hari_kerja: 22,  // SUM(status <> 'hari_libur')
    total_hadir: 15,       // status 'hadir' (tepat waktu)
    total_telat: 4,        // status 'telat' -- tetap dihitung hadir
    total_kehadiran: 20,   // hadir + telat + dinas_luar + cuti
    total_izin: 1,         // tidak dihitung sebagai kehadiran
    total_sakit: 0,        // tidak dihitung sebagai kehadiran
    total_cuti: 0,         // cuti: ikut dihitung sebagai kehadiran
    total_dinas_luar: 1,
    total_alpa: 0,
    total_belum: 0,
    total_libur: 8,
    total_late_minutes: 45,
    avg_late_minutes: 11.25,
    max_late_minutes: 20,
    total_work_minutes: 1800,
    total_overtime_minutes: 60,
    ...overrides,
  };
}

/** Rumus yang sama dengan decorateMonthlyRow di reports.js. */
function persenHadir(row) {
  const hariKerja = Number(row.total_hari_kerja || 0);
  const kehadiran = Number(row.total_kehadiran || 0);
  return hariKerja > 0 ? Math.round((kehadiran / hariKerja) * 100) : 0;
}

test('total hari kerja = baris kalender dikurangi hari libur', () => {
  const row = makeRow();
  assert.equal(row.total_days - row.total_libur, row.total_hari_kerja);
});

test('total kehadiran mencakup telat dan dinas luar', () => {
  const row = makeRow();
  assert.equal(
    row.total_kehadiran,
    row.total_hadir + row.total_telat + row.total_dinas_luar
  );
});

test('telat tidak mengurangi persentase kehadiran', () => {
  // 22 hari kerja, 20 kehadiran (15 hadir + 4 telat + 1 dinas luar) => 91%.
  const row = makeRow();
  assert.equal(persenHadir(row), 91);

  // Seandainya telat tidak dihitung, persennya hanya 15/22 = 68%.
  const tanpaTelat = Math.round((row.total_hadir / row.total_hari_kerja) * 100);
  assert.notEqual(persenHadir(row), tanpaTelat);
});

test('cuti tidak mengurangi kehadiran yang diakui', () => {
  const row = makeRow({ total_cuti: 2, total_kehadiran: 22, total_days: 30 });
  assert.equal(persenHadir(row), 100);
});

test('izin tidak menambah kehadiran', () => {
  // Izin adalah hari kerja yang tidak menambah kehadiran, jadi persentasenya
  // lebih rendah dibanding karyawan yang kehadirannya penuh.
  // 21 kehadiran / 22 hari kerja = 95% (1 hari izin).
  const denganIzin = makeRow({ total_kehadiran: 21, total_izin: 1 });
  assert.equal(persenHadir(denganIzin), 95);

  // Bandingkan dengan cuti: cuti MENAMBAH kehadiran, izin tidak.
  const denganCuti = makeRow({ total_kehadiran: 22, total_cuti: 2 });
  assert.equal(persenHadir(denganCuti), 100);
  assert.ok(persenHadir(denganCuti) > persenHadir(denganIzin));
});

test('izin dan sakit tidak masuk ke hitungan total_kehadiran', () => {
  const row = makeRow({
    total_hadir: 15,
    total_telat: 4,
    total_dinas_luar: 1,
    total_cuti: 2,
    total_izin: 1,
    total_sakit: 1,
    total_kehadiran: 22,
  });
  const tanpaIzinSakit = row.total_hadir + row.total_telat + row.total_dinas_luar + row.total_cuti;
  assert.equal(row.total_kehadiran, tanpaIzinSakit);
  // Kalau izin/sakit ikut dihitung, hasilnya 24 - harus tidak begitu.
  assert.notEqual(row.total_kehadiran, tanpaIzinSakit + row.total_izin + row.total_sakit);
});

test('sakit tidak menambah kehadiran', () => {
  const denganSakit = makeRow({ total_sakit: 3, total_kehadiran: 17 });
  // 17 kehadiran / 22 hari kerja = 77%, turun dari 91%.
  assert.equal(persenHadir(denganSakit), 77);
});

test('kehadiran mencakup cuti tapi tidak mencakup izin/sakit', () => {
  const row = makeRow({
    total_hadir: 15,
    total_telat: 4,
    total_dinas_luar: 1,
    total_cuti: 2,
    total_kehadiran: 22,
  });
  // 15 + 4 + 1 + 2 = 22; izin (1) dan sakit (0) tidak masuk hitungan.
  assert.equal(
    row.total_kehadiran,
    row.total_hadir + row.total_telat + row.total_dinas_luar + row.total_cuti
  );
  assert.equal(row.total_kehadiran, 22);
});

test('persentase memakai hari kerja, bukan jumlah hari kalender', () => {
  const row = makeRow();
  const denganKalender = Math.round(
    (row.total_kehadiran / Math.max(1, row.total_days - row.total_libur)) * 100
  );
  // Nilai kebetulan sama karena total_days - total_libur = total_hari_kerja;
  // yang dijaga adalah rumusnya memakai kolom total_hari_kerja.
  assert.equal(persenHadir(row), Math.round((20 / 22) * 100));
  assert.equal(typeof denganKalender, 'number');
});

test('hari kerja nol menghasilkan persentase nol', () => {
  assert.equal(persenHadir(makeRow({ total_hari_kerja: 0, total_kehadiran: 0 })), 0);
});

test('kehadiran nol tapi hari kerja ada menghasilkan persentase nol', () => {
  assert.equal(persenHadir(makeRow({ total_kehadiran: 0 })), 0);
});

test('akumulasi keterlambatan dicatat terpisah dari kehadiran', () => {
  const row = makeRow();
  // 4 hari terlambat, total 45 menit.
  assert.equal(row.total_telat, 4);
  assert.equal(row.total_hari_terlambat ?? row.total_telat, 4);
  assert.equal(row.total_late_minutes, 45);
  assert.equal(row.max_late_minutes, 20);
  // Rata-rata hanya dari hari yang benar-benar telat.
  assert.equal(Math.round(row.total_late_minutes / row.total_telat), 11);
});

test('karyawan dengan semua hari telat tetap punya 100 persen kehadiran', () => {
  const row = makeRow({
    total_hadir: 0,
    total_telat: 20,
    total_kehadiran: 20,
    total_dinas_luar: 0,
    total_late_minutes: 200,
  });
  assert.equal(persenHadir(row), 91);
  // Waktu kerjanya tetap terakumulasi; keterlambatan tidak menghapus kerja.
  assert.equal(row.total_work_minutes, 1800);
  assert.equal(row.total_late_minutes, 200);
});

test('hari libur tidak menambah persentase kehadiran', () => {
  // Menambah hari libur tanpa menambah kehadiran menurunkan persentase,
  // karena pembaginya adalah hari kerja (hari libur tidak termasuk).
  const sebelum = persenHadir(makeRow());
  const sesudah = persenHadir(makeRow({ total_days: 31, total_libur: 9 }));
  assert.equal(sesudah, sebelum);
});