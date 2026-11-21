'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeBody,
  decodeBody,
  parseFkTime,
  parseFkTimeToMillis,
  mapVerifyCode,
  parseLogRecords,
  parseUserEntries,
} = require('../src/devices/fkweb/codec');
const { CommandQueue } = require('../src/devices/fkweb/queue');
const { setTimeParam } = require('../src/devices/fkweb/commands');

test('encodeBody menulis panjang JSON termasuk NUL', () => {
  const buf = encodeBody('{"a":1}');
  assert.equal(buf.readUInt32LE(0), 8);
  assert.equal(buf.subarray(4, 11).toString('utf8'), '{"a":1}');
  assert.equal(buf[11], 0);
});

test('encodeBody + decodeBody mempertahankan JSON dan biner', () => {
  const bin = Buffer.from([1, 2, 3]);
  const decoded = decodeBody(encodeBody('{"ok":true}', [bin]));
  assert.deepEqual(JSON.parse(decoded.json), { ok: true });
  assert.deepEqual(decoded.bins[0], bin);
});

test('parseFkTime memakai jam dinding WIB', () => {
  assert.equal(parseFkTime('20260929020000'), '2026-09-29 02:00:00');
  const ms = parseFkTimeToMillis('20260929020000');
  assert.equal(new Date(ms).toISOString(), '2026-09-28T19:00:00.000Z');
});

test('mapVerifyCode memetakan jari/password/kartu/wajah', () => {
  assert.equal(mapVerifyCode(0x10000000), 0);
  assert.equal(mapVerifyCode(0x20000000), 2);
  assert.equal(mapVerifyCode(0x30000000), 1);
  assert.equal(mapVerifyCode(0x40000000), 3);
});

test('parseLogRecords membaca record 48 byte', () => {
  const rec = Buffer.alloc(48);
  rec.write('123', 0, 'ascii');
  rec[35] = 7;
  const packed = (2026 - 1900) << 2 | 9 << 12 | 29 << 16 | 14 << 21 | 30 << 26;
  rec.writeUInt32LE(packed >>> 0, 36);
  rec.writeUInt32LE(2 << 24, 40);
  rec.writeUInt32LE(0x10000000, 44);

  const logs = parseLogRecords(rec, 48);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].deviceUserId, '123');
  assert.equal(logs[0].logTime, '2026-09-29 14:30:07');
  assert.equal(logs[0].logState, 1);
  assert.equal(logs[0].verifyMode, 0);
});

test('parseUserEntries membaca record 36 byte', () => {
  const rec = Buffer.alloc(36);
  rec.write('42', 0, 'ascii');
  rec[32] = 1;
  rec[33] = 1;
  rec[34] = 0x0d;

  const users = parseUserEntries(rec, 36);
  assert.equal(users.length, 1);
  assert.equal(users[0].deviceUserId, '42');
  assert.equal(users[0].manager, true);
  assert.equal(users[0].active, true);
});

test('CommandQueue mengirim perintah dan menyelesaikan hasil', async () => {
  const queue = new CommandQueue();
  const pending = queue.enqueue('dev-1', 'GET_LOG_DATA', Buffer.alloc(0));

  const entry = queue.next('dev-1');
  assert.ok(entry);
  assert.equal(entry.code, 'GET_LOG_DATA');
  assert.equal(queue.next('dev-1'), null);

  const result = { json: { log_count: 1 }, bins: [] };
  assert.equal(queue.complete('dev-1', entry.transId, result), true);
  assert.deepEqual(await pending, result);
  assert.equal(queue.complete('dev-1', entry.transId, result), false);
});

test('setTimeParam berisi JSON time 14 digit', () => {
  const decoded = decodeBody(setTimeParam());
  assert.match(JSON.parse(decoded.json).time, /^\d{14}$/);
});
