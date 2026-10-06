'use strict';

/**
 * Tes opsi "memakai kendaraan operasional" pada pengajuan dinas luar kota.
 *
 * Aturan yang dijaga:
 *   - hanya Dinas Luar Kota yang boleh memakai kendaraan
 *   - nilai checkbox dinormalisasi menjadi 0/1
 *   - pengajuan lain SELALU 0 walau klien mengirim use_vehicle, supaya tidak
 *     ada pengantar mobil yang bisa dicetak untuk pengajuan yang tidak berhak
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const leaveCatalog = require('../src/services/leaveCatalog');
const { normalizeUseVehicle } = require('../src/services/employeePortal');

const DINAS_LUAR = leaveCatalog.findSubtype('dinas_luar_kota');
const DINAS_DALAM = leaveCatalog.findSubtype('dinas_dalam_kota');
const CUTI_TAHUNAN = leaveCatalog.findSubtype('cuti_tahunan');
const IZIN_TIDAK_MASUK = leaveCatalog.findSubtype('izin_tidak_masuk');

test('hanya dinas luar kota yang punya needs_vehicle', () => {
  assert.equal(DINAS_LUAR.needs_vehicle, true);
  assert.equal(DINAS_DALAM.needs_vehicle, undefined);
  assert.equal(CUTI_TAHUNAN.needs_vehicle, undefined);
  assert.equal(IZIN_TIDAK_MASUK.needs_vehicle, undefined);
});

test('VEHICLE_SUBTYPES hanya berisi dinas luar kota', () => {
  assert.deepEqual(leaveCatalog.VEHICLE_SUBTYPES, ['dinas_luar_kota']);
});

test('toPublicOptions mengirim needs_vehicle ke frontend', () => {
  const dinas = leaveCatalog
    .toPublicOptions()
    .find((c) => c.key === 'dinas');

  const luar = dinas.subtypes.find((s) => s.key === 'dinas_luar_kota');
  const dalam = dinas.subtypes.find((s) => s.key === 'dinas_dalam_kota');

  assert.equal(luar.needs_vehicle, true);
  assert.equal(dalam.needs_vehicle, false);
});

test('checkbox centang pada dinas luar kota menghasilkan 1', () => {
  for (const value of [true, 1, '1', 'true', 'yes', 'on', 'TRUE']) {
    assert.equal(normalizeUseVehicle(value, DINAS_LUAR), 1, `nilai ${value}`);
  }
});

test('checkbox tidak centang pada dinas luar kota menghasilkan 0', () => {
  for (const value of [false, 0, '0', 'false', '', null, undefined]) {
    assert.equal(normalizeUseVehicle(value, DINAS_LUAR), 0, `nilai ${value}`);
  }
});

test('jenis selain dinas luar kota selalu 0 walau klien mengirim true', () => {
  // Ini yang mencegah pengantar palsu: kalau checkbox disembunyikan tapi
  // nilainya masih terkirim, pengantar tetap bisa dicetak.
  for (const subtype of [DINAS_DALAM, CUTI_TAHUNAN, IZIN_TIDAK_MASUK, null, undefined]) {
    assert.equal(
      normalizeUseVehicle(true, subtype),
      0,
      `subtype ${subtype && subtype.key} tidak boleh memakai kendaraan`
    );
  }
});

test('nilai acak tidak dianggap true', () => {
  for (const value of ['ya-ah', 'mungkin', 2, -1, 'on-ish']) {
    assert.equal(normalizeUseVehicle(value, DINAS_LUAR), 0, `nilai ${value}`);
  }
});

test('use_vehicle hanya berlaku untuk leave_type dinas_luar', () => {
  // Pengaman tambahan: kalau katalog berubah dan dinas dalam kota ikut
  // dapat needs_vehicle, tes VEHICLE_SUBTYPES di atas akan gagal.
  const subtypesDenganKendaraan = leaveCatalog.CATEGORIES
    .flatMap((c) => c.subtypes)
    .filter((s) => s.needs_vehicle)
    .map((s) => s.key);

  assert.deepEqual(subtypesDenganKendaraan, ['dinas_luar_kota']);
});