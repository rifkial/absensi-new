'use strict';

/**
 * Tes katalog model mesin (src/devices/models.js).
 *
 * Katalog ini mengisi preset di form "Tambah Perangkat", jadi model harus
 * menunjuk protokol yang benar-benar terdaftar & port yang masuk akal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { listModels, defaultPort } = require('../src/devices/models');
const { hasAdapter } = require('../src/devices');
const config = require('../src/config');

test('katalog memuat Fingerspot All Series', () => {
  const model = listModels().find((m) => m.id === 'fingerspot-all-series');
  assert.ok(model, 'model Fingerspot All Series harus ada di katalog');
  assert.equal(model.brand, 'Fingerspot');
  assert.equal(model.model, 'All Series');
  assert.equal(model.protocol, 'zkteco-tcp');
  assert.equal(model.port, 4370);
});

test('katalog memuat Fingerspot Revo WFV-208BNC+ (FkWeb)', () => {
  const model = listModels().find((m) => m.id === 'fingerspot-revo-wfv-208bnc');
  assert.ok(model, 'model Revo WFV-208BNC+ harus ada di katalog');
  assert.equal(model.brand, 'Fingerspot');
  assert.equal(model.protocol, 'fkweb-http');
  assert.equal(model.port, config.server.fkwebPort);
});

test('katalog memuat Solution All Series', () => {
  const model = listModels().find((m) => m.id === 'solution-all-series');
  assert.ok(model, 'model Solution All Series harus ada di katalog');
  assert.equal(model.brand, 'Solution');
  assert.equal(model.protocol, 'zkteco-tcp');
  assert.equal(model.port, 4370);
});

test('setiap model menunjuk protokol yang terdaftar', () => {
  for (const model of listModels()) {
    assert.ok(hasAdapter(model.protocol), `protokol "${model.protocol}" model ${model.id} belum terdaftar`);
    for (const alt of model.also_supports || []) {
      assert.ok(hasAdapter(alt), `protokol alternatif "${alt}" model ${model.id} belum terdaftar`);
    }
    assert.equal(model.port, defaultPort(model.protocol), `port model ${model.id} tidak sama dengan port default protokol`);
  }
});

test('setiap model dengan panduan setup punya struktur valid', () => {
  for (const model of listModels()) {
    if (!model.setup) continue;
    assert.ok(Array.isArray(model.setup) && model.setup.length > 0, `model ${model.id} harus punya panduan setup`);
    for (const section of model.setup) {
      assert.ok(section.title, 'setiap bagian setup harus punya judul');
      assert.ok(Array.isArray(section.steps) && section.steps.length > 0, 'setiap bagian setup harus punya langkah');
    }
  }
});

test('defaultPort memetakan protokol yang dikenal', () => {
  assert.equal(defaultPort('zkteco-tcp'), 4370);
  assert.equal(defaultPort('push-http'), 3001);
  assert.equal(defaultPort('fkweb-http'), config.server.fkwebPort);
});
