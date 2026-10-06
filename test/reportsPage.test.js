'use strict';

/**
 * Cek bahwa setiap id yang dicari getElementById di halaman Laporan benar-benar
 * ada di markup yang di-render.
 *
 * Bug ini pernah terjadi: bind() mencari 'rpPreview' sementara tombolnya
 * id="repPreview", sehingga listener tidak pernah terpasang dan klik tombol
 * Tampilkan tidak melakukan apa-apa. Tes ini menjaga agar tidak terulang.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'public', 'js', 'pages', 'reports.js');
const source = fs.readFileSync(SRC, 'utf8');

/** Semua id yang dibaca lewat getElementById di file ini. */
function idsUsed() {
  const found = new Set();
  const re = /getElementById\(\s*'([^']+)'\s*\)/g;
  let m = re.exec(source);
  while (m) {
    found.add(m[1]);
    m = re.exec(source);
  }
  return [...found];
}

/** Semua id yang ada di literal markup (id="..."). */
function idsDeclared() {
  const found = new Set();
  const re = /\bid="([^"]+)"/g;
  let m = re.exec(source);
  while (m) {
    found.add(m[1]);
    m = re.exec(source);
  }
  return [...found];
}

test('semua id yang dicari getElementById ada di markup', () => {
  const used = idsUsed();
  const declared = new Set(idsDeclared());

  // Semua id dibaca dari markup literal, jadi cukup dicek apa adanya.
  const missing = used.filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `id tidak ada di markup: ${missing.join(', ')}`);
});

test('tombol Tampilkan punya id yang sama dengan yang dicari bind()', () => {
  // Ingin menangkap regresi typo prefix rp/rep.
  assert.match(source, /id="repPreview"/, 'markup harus punya id="repPreview"');
  assert.match(
    source,
    /getElementById\('repPreview'\)/,
    'bind() harus mencari "repPreview", bukan "rpPreview"'
  );
  assert.doesNotMatch(
    source,
    /getElementById\('rpPreview'\)/,
    'jangan cari "rpPreview"; tombolnya "repPreview"'
  );
});

test('tombol Tampilkan memasang listener klik', () => {
  assert.match(
    source,
    /preview\.addEventListener\(\s*'click',\s*loadPreview\s*\)/,
    'listener klik pada tombol Tampilkan harus terpasang'
  );
});