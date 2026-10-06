'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertDutyWorkDate, dutyRangeOf } = require('../src/services/employeePortal');

const LEAVE = { start_date: '2026-10-06', end_date: '2026-10-08' };

test('check-in di dalam rentang lolos', () => {
  const r = assertDutyWorkDate('2026-10-07', LEAVE, '2026-10-07');
  assert.deepEqual(r, { start: '2026-10-06', end: '2026-10-08' });
});

test('tanggal selain hari ini ditolak', () => {
  assert.throws(() => assertDutyWorkDate('2026-10-07', LEAVE, '2026-10-06'), /hanya bisa untuk hari ini/);
});

test('hari ini di luar rentang persetujuan ditolak', () => {
  assert.throws(() => assertDutyWorkDate('2026-10-09', LEAVE, '2026-10-09'), /di luar rentang/);
});

test('tanpa persetujuan ditolak', () => {
  assert.throws(() => assertDutyWorkDate('2026-10-07', null, '2026-10-07'), /Tidak ada persetujuan/);
});

test('dutyRangeOf null -> null', () => {
  assert.equal(dutyRangeOf(null), null);
});
