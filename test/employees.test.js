'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const employees = require('../src/services/employees');

test('normalize menerima keempat status karyawan', () => {
  for (const sk of ['tetap', 'kontrak', 'harian_lepas', 'magang']) {
    const data = employees.normalize({ employee_code: 'T1', name: 'Tes', status_karyawan: sk }, { partial: true });
    assert.equal(data.status_karyawan, sk);
  }
});

test('normalize menolak status karyawan tak dikenal', () => {
  assert.throws(
    () => employees.normalize({ status_karyawan: 'honorer' }, { partial: true }),
    /status_karyawan/
  );
});

test('normalize tidak mengisi status_karyawan bila payload kosong (default "tetap" dipasang saat create)', () => {
  const data = employees.normalize({ employee_code: 'T1', name: 'Tes' });
  assert.ok(!('status_karyawan' in data));
});
