'use strict';

/**
 * Tes katalog & normalisasi pengajuan reimbursement.
 *
 * Yang dijaga di sini adalah aturan yang tidak boleh dilewati server:
 *   - jumlah harus angka positif dan dibatasi sesuai DECIMAL(12,2)
 *   - total selalu dihitung ulang dari rincian, bukan dipercaya dari klien
 *   - jenis biaya harus salah satu dari katalog
 *   - tanggal transaksi tidak boleh di masa depan / terlalu lama lalu
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../src/services/reimburseCatalog');
const { normalizeExpenseDate } = require('../src/services/employeePortal');

const { normalizeItems } = catalog;

test('katalog jenis biaya punya key unik dan label', () => {
  const keys = catalog.CATEGORIES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const cat of catalog.CATEGORIES) {
    assert.ok(cat.label, `kategori ${cat.key} harus punya label`);
    assert.equal(catalog.isValidKey(cat.key), true);
  }
});

test('findCategory dan labelFor bekerja untuk key valid dan tidak valid', () => {
  assert.equal(catalog.findCategory('transportasi').label, 'Transportasi');
  assert.equal(catalog.findCategory('tidak_ada'), null);
  assert.equal(catalog.labelFor('makan'), 'Makan / Konsumsi');
  assert.equal(catalog.isValidKey('entah'), false);
  assert.equal(catalog.isValidKey(null), false);
});

test('bentuk sederhana (tanpa items) tetap jadi satu rincian', () => {
  const { items, total } = normalizeItems({
    description: 'Tilet bus',
    amount: 150000,
    category: 'transportasi',
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Tilet bus');
  assert.equal(items[0].amount, 150000);
  assert.equal(total, 150000);
});

test('beberapa rincian dijumlahkan menjadi total', () => {
  const { items, total } = normalizeItems({
    items: [
      { description: 'Tiket bus', amount: 150000 },
      { description: 'Makan 2x', amount: 65000.5 },
      { description: 'Penginapan', amount: 300000 },
    ],
  });

  assert.equal(items.length, 3);
  assert.equal(total, 515000.5);
});

test('total mengabaikan nilai total yang dikirim klien', () => {
  const { total } = normalizeItems({
    amount: 1000,
    description: 'Asli',
    total: 999999999,
  });

  assert.equal(total, 1000);
});

test('jumlah dibulatkan ke dua desimal', () => {
  const { items, total } = normalizeItems({
    items: [
      { description: 'A', amount: 1000.005 },
      { description: 'B', amount: 0.004 },
    ],
  });

  assert.equal(items[0].amount, 1000.01);
  assert.equal(items[1].amount, 0);
  assert.equal(total, 1000.01);
});

test('jumlah nol atau negatif ditolak', () => {
  assert.throws(() => normalizeItems({ description: 'X', amount: 0 }), /lebih besar dari nol/);
  assert.throws(() => normalizeItems({ description: 'X', amount: -5 }), /lebih besar dari nol/);
});

test('jumlah bukan angka ditolak', () => {
  assert.throws(() => normalizeItems({ description: 'X', amount: 'abc' }), /tidak valid/);
  assert.throws(() => normalizeItems({ description: 'X', amount: null }), /tidak valid/);
});

test('jumlah melebihi batas DECIMAL(12,2) ditolak', () => {
  assert.throws(
    () => normalizeItems({ description: 'X', amount: catalog.MAX_AMOUNT + 1 }),
    /melebihi batas/
  );
});

test('keterangan kosong ditolak', () => {
  assert.throws(() => normalizeItems({ description: '   ', amount: 1000 }), /wajib diisi/);
});

test('jenis biaya di luar katalog ditolak', () => {
  assert.throws(
    () => normalizeItems({ description: 'X', amount: 1000, category: 'ngarang' }),
    /tidak dikenal/
  );
});

test('kategori bisa diambil dari payload overall saat rincian kosong', () => {
  const { items } = normalizeItems({ description: 'X', amount: 1000, category: 'atk' });
  assert.equal(items[0].category, 'atk');
});

test('batas jumlah baris per pengajuan dipatuhi', () => {
  const items = Array.from({ length: catalog.MAX_ITEMS + 1 }, (_, i) => ({
    description: `Baris ${i}`,
    amount: 1000,
  }));
  assert.throws(() => normalizeItems({ items }), /Maksimal/);
});

test('items berupa string JSON (dari FormData) diterima', () => {
  // FormData hanya bisa mengirim string, jadi frontend wajib JSON.stringify.
  // Kalau string tidak di-parse, payload dianggap satu rincian tanpa keterangan.
  const { items, total } = normalizeItems({
    items: JSON.stringify([
      { description: 'Tilet bus', amount: 150000, category: 'transportasi' },
      { description: 'Makan', amount: 50000, category: 'makan' },
    ]),
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].description, 'Tilet bus');
  assert.equal(items[1].description, 'Makan');
  assert.equal(total, 200000);
});

test('items string JSON dengan spasi kosong tetap jadi satu rincian', () => {
  const { items } = normalizeItems({
    items: '   ',
    description: 'Langsung',
    amount: 1000,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Langsung');
});

test('items string JSON rusak ditolak dengan pesan jelas', () => {
  assert.throws(
    () => normalizeItems({ items: '{bukan json' }),
    /tidak dapat dibaca/
  );
});

test('items berupa objek tunggal (bukan array) diterima', () => {
  const { items, total } = normalizeItems({
    items: { description: 'Sebut saja', amount: 7500 },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Sebut saja');
  assert.equal(total, 7500);
});

test('items array kosong jatuh ke bentuk sederhana', () => {
  const { items } = normalizeItems({
    items: [],
    description: 'Cadangan',
    amount: 1000,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].description, 'Cadangan');
});

test('keterangan dipotong pada 500 karakter', () => {
  const panjang = 'x'.repeat(700);
  const { items } = normalizeItems({ description: panjang, amount: 1000 });
  assert.equal(items[0].description.length, 500);
});

test('tanggal transaksi kosong tidak error', () => {
  assert.equal(normalizeExpenseDate(''), null);
  assert.equal(normalizeExpenseDate(undefined), null);
});

test('tanggal transaksi tidak boleh di masa depan', () => {
  const besok = new Date();
  besok.setDate(besok.getDate() + 1);
  const iso = besok.toISOString().slice(0, 10);
  assert.throws(() => normalizeExpenseDate(iso), /masa depan/);
});

test('tanggal transaksi terlalu lama ditolak', () => {
  const lama = new Date();
  lama.setDate(lama.getDate() - (catalog.MAX_BACKDATE_DAYS + 1));
  const iso = lama.toISOString().slice(0, 10);
  assert.throws(() => normalizeExpenseDate(iso), /tidak boleh lebih dari/);
});

test('tanggal transaksi hari ini diterima', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(normalizeExpenseDate(today), today);
});