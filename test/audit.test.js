'use strict';

/**
 * Tes sanitasi jejak audit (src/services/audit.js).
 *
 * Fungsi sanitize() menentukan data apa yang boleh masuk tabel audit_logs.
 * Kegagalan di sini bisa membocorkan password ke log.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, ipOf } = require('../src/services/audit');

test('password tidak pernah ikut tersimpan', () => {
  const out = sanitize({ username: 'admin', password: 'Rahasia123' });
  assert.ok(!out.includes('Rahasia123'), 'password harus disamarkan');
  assert.ok(out.includes('admin'), 'username tetap tersimpan');
});

test('berbagai kunci rahasia ditutup', () => {
  const out = sanitize({
    password_hash: '$2a$10$abcdef',
    new_password: 'baru123',
    current_password: 'lama123',
    token: 'jwt-abc',
    push_auth_token: 'push-xyz',
    whatsapp_token: 'wa-123',
    mail_pass: 'smtp-pass',
    jwt_secret: 'rahasia',
  });

  for (const value of ['$2a$10$abcdef', 'baru123', 'lama123', 'jwt-abc', 'push-xyz', 'wa-123', 'smtp-pass', 'rahasia']) {
    assert.ok(!out.includes(value), `${value} tidak boleh bocor`);
  }
});

test('nama kunci rahasia tidak case-sensitive', () => {
  const out = sanitize({ PASSWORD: 'Rahasia123', Password_Hash: 'abc' });
  assert.ok(!out.includes('Rahasia123'));
});

test('nilai biasa tetap tersimpan utuh', () => {
  const out = sanitize({ name: 'Ahmad', status: 'aktif', quota: 12 });
  assert.ok(out.includes('Ahmad'));
  assert.ok(out.includes('aktif'));
  assert.ok(out.includes('12'));
});

test('nilai null dan undefined tidak membuat masalah', () => {
  const out = sanitize({ a: null, b: undefined, c: 0, d: false });
  assert.ok(out.includes('null'));
  assert.ok(out.includes('0'), 'nilai 0 harus tetap tercatat');
  assert.ok(out.includes('false'));
});

test('teks panjang dipotong supaya kolom TEXT tidak penuh', () => {
  const out = sanitize({ note: 'x'.repeat(10000) });
  assert.ok(out.length <= 4005, `panjang hasil ${out.length} melebihi batas`);
});

test('objek di dalam diratakan jadi JSON', () => {
  const out = sanitize({ changes: { status: { from: 'alpa', to: 'izin' } } });
  assert.ok(out.includes('alpa'));
  assert.ok(out.includes('izin'));
});

test('input kosong menghasilkan null', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(undefined), null);
});

test('ipOf mengembalikan IP dari request', () => {
  assert.equal(ipOf({ ip: '10.0.0.5' }), '10.0.0.5');
  assert.equal(ipOf({ socket: { remoteAddress: '10.0.0.6' } }), '10.0.0.6');
  assert.equal(ipOf(null), null);
});
