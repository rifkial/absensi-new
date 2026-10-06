'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const realtime = require('../src/services/realtime');

test('notifyUsers tanpa penerima -> nol', async () => {
  const r = await realtime.notifyUsers([], { kind: 'leave.submitted', title: 'x' });
  assert.deepEqual(r, { saved: 0, pushed: 0 });
});

test('pushToUser tanpa koneksi -> nol', () => {
  assert.equal(realtime.pushToUser(999999, { title: 'x' }), 0);
});

test('SSE client add/remove bersih', () => {
  const writes = [];
  const fake = { write: (s) => writes.push(s) };
  realtime.addClient(12345, fake);
  assert.equal(realtime.pushToUser(12345, { title: 'halo' }), 1);
  assert.ok(writes.join('').includes('notify'));
  realtime.removeClient(12345, fake);
  assert.equal(realtime.pushToUser(12345, { title: 'halo' }), 0);
});
