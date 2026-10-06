'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTravel, defaultLetterNo, isDinas, assertApprovable } = require('../src/services/travelLetter');

test('normalize potong + kosong jadi null', () => {
  assert.deepEqual(normalizeTravel({ transport: '  Mobil dinas  ', travel_letter_no: ' SPD/1 ' }), {
    transport: 'Mobil dinas',
    travel_letter_no: 'SPD/1',
  });
  assert.deepEqual(normalizeTravel({ transport: '   ', travel_letter_no: '' }), {
    transport: null,
    travel_letter_no: null,
  });
});

test('nomor default format SPD', () => {
  assert.equal(defaultLetterNo(7, '2026-10-06'), 'SPD/0007/10/2026');
});

test('hanya dinas approved lolos', () => {
  assert.equal(isDinas({ leave_type: 'dinas_luar' }), true);
  assert.equal(isDinas({ leave_type: 'cuti' }), false);
  assert.throws(() => assertApprovable({ leave_type: 'cuti', status: 'approved' }), /hanya untuk pengajuan dinas/);
  assert.throws(() => assertApprovable({ leave_type: 'dinas_luar', status: 'pending' }), /setelah dinas disetujui/);
  assertApprovable({ leave_type: 'dinas_dalam', status: 'approved' });
});
