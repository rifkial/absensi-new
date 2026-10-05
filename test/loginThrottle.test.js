'use strict';

/**
 * Tes pembatas percobaan login (src/services/loginThrottle.js).
 *
 * Modul ini menjaga pintu masuk aplikasi, jadi harus diuji tanpa database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const throttle = require('../src/services/loginThrottle');

/** Set policy yang mudah diprediksi lalu bersihkan state. */
function withPolicy(options = {}) {
  throttle.reset();
  throttle.applySettings({
    login_rate_limit_enabled: 'true',
    login_free_attempts: String(options.freeAttempts ?? 3),
    login_lock_threshold: String(options.lockThreshold ?? 100),
    login_lock_seconds: String(options.lockSeconds ?? 60),
  });
}

test('percobaan pertama selalu diizinkan', () => {
  withPolicy({ freeAttempts: 3 });
  const result = throttle.check('1.1.1.1', 'admin');
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test('salah ketik beberapa kali masih diizinkan sampai ambang', () => {
  withPolicy({ freeAttempts: 3 });

  for (let i = 0; i < 3; i += 1) {
    assert.equal(throttle.check('1.1.1.1', 'admin').allowed, true, `percobaan ${i + 1}`);
    throttle.registerFailure('1.1.1.1', 'admin');
  }
});

test('setelah ambang, permintaan ditunda dengan retry-after', () => {
  withPolicy({ freeAttempts: 2 });
  throttle.registerFailure('1.1.1.1', 'admin');
  throttle.registerFailure('1.1.1.1', 'admin');

  const blocked = throttle.check('1.1.1.1', 'admin');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'throttled');
  assert.ok(blocked.retryAfter > 0, 'retryAfter harus lebih dari 0');
});

test('jeda bertambah setiap kali gagal lagi', () => {
  withPolicy({ freeAttempts: 1 });

  throttle.registerFailure('2.2.2.2', 'admin');
  const first = throttle.check('2.2.2.2', 'admin');
  assert.equal(first.allowed, false);
  const delay1 = first.retryAfter;

  // Paksa lewat masa tunggu dengan menggeser waktu rekaman ke belakang.
  throttle.registerFailure('2.2.2.2', 'admin');
  const second = throttle.check('2.2.2.2', 'admin');
  assert.ok(second.retryAfter >= delay1, `jeda kedua (${second.retryAfter}) harus >= pertama (${delay1})`);
});

test('IP berbeda tidak saling memengaruhi', () => {
  withPolicy({ freeAttempts: 2 });

  for (let i = 0; i < 5; i += 1) throttle.registerFailure('3.3.3.3', 'admin');

  assert.equal(throttle.check('3.3.3.3', 'admin').allowed, false);
  assert.equal(throttle.check('3.3.3.4', 'admin').allowed, true, 'IP lain harus bebas');
});

test('username berbeda tidak saling memengaruhi', () => {
  withPolicy({ freeAttempts: 2 });

  for (let i = 0; i < 5; i += 1) throttle.registerFailure('4.4.4.4', 'admin');

  assert.equal(throttle.check('4.4.4.4', 'admin').allowed, false);
  assert.equal(throttle.check('4.4.4.4', 'operator').allowed, true, 'username lain harus bebas');
});

test('username tidak case-sensitive', () => {
  withPolicy({ freeAttempts: 2 });

  throttle.registerFailure('5.5.5.5', 'Admin');
  throttle.registerFailure('5.5.5.5', 'ADMIN');

  assert.equal(throttle.check('5.5.5.5', 'admin').allowed, false);
});

test('ambang kunci mengunci akun sementara lintas IP', () => {
  withPolicy({ freeAttempts: 100, lockThreshold: 3, lockSeconds: 60 });

  // Serangan dari tiga IP berbeda ke username yang sama.
  throttle.registerFailure('6.6.6.1', 'admin');
  throttle.registerFailure('6.6.6.2', 'admin');
  throttle.registerFailure('6.6.6.3', 'admin');

  const locked = throttle.check('6.6.6.9', 'admin');
  assert.equal(locked.allowed, false);
  assert.equal(locked.reason, 'locked');
  assert.ok(locked.retryAfter > 0);
});

test('password benar ikut tertahan saat akun terkunci', () => {
  withPolicy({ freeAttempts: 100, lockThreshold: 2, lockSeconds: 60 });

  throttle.registerFailure('7.7.7.1', 'admin');
  throttle.registerFailure('7.7.7.2', 'admin');

  // Gate tidak tahu password; ia hanya menghitung waktu. Ini disengaja:
  // selama terkunci, tidak ada password yang dicoba.
  assert.equal(throttle.check('7.7.7.1', 'admin').allowed, false);
});

test('login berhasil membersihkan hitungan pasangan IP + username', () => {
  withPolicy({ freeAttempts: 2 });

  throttle.registerFailure('8.8.8.8', 'admin');
  throttle.registerFailure('8.8.8.8', 'admin');
  assert.equal(throttle.check('8.8.8.8', 'admin').allowed, false);

  throttle.registerSuccess('8.8.8.8', 'admin');
  assert.equal(throttle.check('8.8.8.8', 'admin').allowed, true, 'setelah login berhasil harus bebas lagi');
});

test('applySettings mengabaikan nilai tidak valid', () => {
  throttle.reset();
  const policy = throttle.applySettings({
    login_free_attempts: 'bukan angka',
    login_lock_threshold: '',
    login_lock_seconds: '999999999',
  });

  assert.equal(typeof policy.freeAttempts, 'number');
  assert.ok(policy.freeAttempts >= 1);
  assert.ok(policy.lockSeconds <= 86400, 'durasi kunci dibatasi maksimal 1 hari');
});

test('nilai di luar rentang dijepit ke batas', () => {
  const policy = throttle.applySettings({
    login_free_attempts: '0',
    login_lock_threshold: '100000',
  });

  assert.equal(policy.freeAttempts, 1);
  assert.equal(policy.lockThreshold, 1000);
});

test('reset mengosongkan seluruh state', () => {
  withPolicy({ freeAttempts: 1 });
  throttle.registerFailure('9.9.9.9', 'admin');
  assert.equal(throttle.check('9.9.9.9', 'admin').allowed, false);

  throttle.reset();
  assert.equal(throttle.check('9.9.9.9', 'admin').allowed, true);
});
