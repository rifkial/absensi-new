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

test('satu user satu koneksi, lama ditutup', () => {
  let ended = 0;
  const a = { write: () => {}, end: () => { ended += 1; } };
  const b = { write: () => {}, end: () => {} };
  realtime.addClient(54321, a);
  assert.equal(realtime.clientCount(), 1);
  realtime.addClient(54321, b);
  assert.equal(ended, 1);
  assert.equal(realtime.clientCount(), 1);
  realtime.removeClient(54321, b);
  assert.equal(realtime.clientCount(), 0);
});
