'use strict';

/**
 *Tes penolakan scan dari mesin fingerprint yang tidak ditunjuk.
 *
 * Aturan yang dijaga:
 *   - setting mati -> semua scan tetap diterima (perilaku lama)
 *   - karyawan tanpa mesin yang ditunjuk -> semua scan diterima
 *   - scan dari mesin yang ditunjuk -> diterima
 *   - scan dari mesin lain -> ditolak hanya saat setting aktif
 *   - impor CSV dan log manual -> tidak pernah affected, walau mesin tidak cocok
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAcceptedByDevice } = require('../src/devices/zkteco4370/adapter');

test('setting mati menerima scan dari mesin mana saja', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: false, assignedDeviceId: 1, scanDeviceId: 2, source: 'sync' }),
    true
  );
});

test('setting mati menerima scan untuk karyawan tanpa mesin yang ditunjuk', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: false, assignedDeviceId: null, scanDeviceId: 2, source: 'sync' }),
    true
  );
});

test('setting aktif menerima scan dari mesin yang ditunjuk', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: 1, source: 'sync' }),
    true
  );
});

test('setting aktif menolak scan dari mesin lain', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: 2, source: 'sync' }),
    false
  );
});

test('setting aktif menolak scan mesin lain dari PUSH juga', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: 3, source: 'push' }),
    false
  );
});

test('setting aktif tetap menerima karyawan yang tidak punya mesin yang ditunjuk', () => {
  // Karyawan tanpa device_id memang bebas absen di semua mesin.
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: null, scanDeviceId: 9, source: 'sync' }),
    true
  );
});

test('setting aktif menerima scan tanpa device_id (tidak ada bukti mesin mana)', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: null, source: 'sync' }),
    true
  );
});

test('impor CSV tidak pernah ditolak walau mesin tidak sesuai', () => {
  // Impor CSV adalah tindakan manual admin, jadi tetap disimpan.
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: 7, source: 'import' }),
    true
  );
});

test('log manual tidak pernah ditolak walau mesin tidak sesuai', () => {
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: 7, source: 'manual' }),
    true
  );
});

test('perbandingan mesin tidak membedakan string dan angka', () => {
  // PIN dari mesin sering datang sebagai string; device_id dari DB sebagai angka.
  assert.equal(
    isAcceptedByDevice({ enforce: true, assignedDeviceId: 1, scanDeviceId: '1', source: 'sync' }),
    true
  );
});