'use strict';

/**
 * Tes helper reverse geocoding: penyusunan nama lokasi dari bagian-bagian
 * alamat OpenStreetMap. Fungsi `reverse` sendiri memanggil jaringan sehingga
 * tidak diuji di sini; yang diuji adalah logika offline-nya.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatAddress } = require('../src/services/geocode');

test('formatAddress menyusun nama jalan, kelurahan, dan kecamatan', () => {
  const out = formatAddress({
    road: 'Jalan Melati',
    village: 'Kebon Melati',
    city_district: 'Tanah Abang',
    city: 'Jakarta Pusat',
  });
  assert.equal(out, 'Jalan Melati, Kebon Melati, Tanah Abang');
});

test('formatAddress menambahkan nomor rumah setelah nama jalan', () => {
  const out = formatAddress({ road: 'Jl. Merdeka', house_number: '12' });
  assert.equal(out, 'Jl. Merdeka No. 12');
});

test('formatAddress membuang bagian duplikat (mis. kelurahan = kecamatan)', () => {
  const out = formatAddress({ road: 'Jl. Kenari', suburb: 'Cibiru', city_district: 'Cibiru' });
  assert.equal(out, 'Jl. Kenari, Cibiru');
});

test('formatAddress membuang bagian kosong', () => {
  const out = formatAddress({ road: 'Jl. Sudirman', neighbourhood: '', village: null });
  assert.equal(out, 'Jl. Sudirman');
});

test('formatAddress mengembalikan string kosong bila tidak ada data', () => {
  assert.equal(formatAddress(), '');
  assert.equal(formatAddress({}), '');
});

test('formatAddress memakai pedestrian bila road tidak ada', () => {
  assert.equal(formatAddress({ pedestrian: 'Gang Melati' }), 'Gang Melati');
});