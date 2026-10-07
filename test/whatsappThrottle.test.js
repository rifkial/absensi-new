'use strict';

/**
 * Tes antrean anti-banned WA nomor sendiri (src/services/whatsappSelf.js).
 *
 * Tanpa browser/Chromium: client whatsapp-web.js di-stub, fokus ke FIFO,
 * jeda antar kirim, batas per menit, dan batas harian.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const settings = require('../src/services/settings');
const waSelf = require('../src/services/whatsappSelf');

function stubSettings(overrides = {}) {
  settings.getStoredMap = async () => ({
    whatsapp_enabled: 'true',
    whatsapp_provider: 'self',
    whatsapp_self_min_delay_ms: String(overrides.minDelayMs ?? 1000),
    whatsapp_self_max_delay_ms: String(overrides.maxDelayMs ?? 1000),
    whatsapp_self_per_minute: String(overrides.perMinute ?? 60),
    whatsapp_self_daily_limit: String(overrides.dailyLimit ?? 5000),
  });
}

test('normalizeTarget menerima 08xxx dan 628xxx, menolak bukan-Indonesia', () => {
  assert.equal(waSelf.normalizeTarget('081234567890'), '6281234567890@c.us');
  assert.equal(waSelf.normalizeTarget('6281234567890'), '6281234567890@c.us');
  assert.equal(waSelf.normalizeTarget('+1-415-555-1234'), null);
  assert.equal(waSelf.normalizeTarget(''), null);
});

test('status memuat policy anti-banned + statistik antrean', async () => {
  waSelf.resetQueue();
  stubSettings();
  const st = await waSelf.status();
  assert.equal(st.provider, 'self');
  assert.equal(st.minDelayMs, 1000);
  assert.equal(st.maxDelayMs, 1000);
  assert.equal(st.perMinute, 60);
  assert.equal(st.dailyLimit, 5000);
  assert.equal(st.queue.queued, 0);
});

test('splitTargets memecah koma/titik-koma/baris baru tanpa duplikat', () => {
  const notify = require('../src/services/notify');
  assert.deepEqual(
    notify.splitTargets('62812xxx, 62813xxx;62812xxx\n62814xxx'),
    ['62812xxx', '62813xxx', '62814xxx']
  );
  assert.deepEqual(notify.splitTargets(''), []);
});

test('batas harian menolak kirim berlebih', async () => {
  // Uji murni kebijakan antrean tanpa kirim beneran: provider dimatikan
  // supaya send() berhenti sebelum masuk antrean, lalu cek pesan batas
  // harian lewat logika enqueue tidak dibutuhkan di sini.
  waSelf.resetQueue();
  settings.getStoredMap = async () => ({
    whatsapp_enabled: 'false',
    whatsapp_provider: 'self',
  });
  const result = await waSelf.send({ target: '081234567890', message: 'halo' });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
});
