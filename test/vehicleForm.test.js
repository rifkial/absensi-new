'use strict';

/**
 * Cek bahwa checkbox "memakai kendaraan operasional" ada di SEMUA form
 * pengajuan, dan selalu disembunyikan sampai jenisnya Dinas Luar Kota.
 *
 * Bug yang pernah terjadi: checkbox hanya ditambahkan di portal karyawan dan
 * form detail karyawan, tapi lupa di "+ Input Pengajuan" pada menu Pengajuan.
 * Tes ini menutup celah itu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = path.join(__dirname, '..', 'public', 'js', 'pages');

function read(file) {
  return fs.readFileSync(path.join(PAGES, file), 'utf8');
}

// Prefix id per form pengajuan.
const FORMS = [
  { file: 'employee.js', wrap: 'lfVehicleWrap', box: 'lfUseVehicle' },
  { file: 'employees.js', wrap: 'lvVehicleWrap', box: 'lvUseVehicle' },
  { file: 'pengajuan.js', wrap: 'ncVehicleWrap', box: 'ncUseVehicle' },
];

for (const form of FORMS) {
  test(`${form.file}: checkbox kendaraan ada di markup`, () => {
    const src = read(form.file);
    assert.match(
      src,
      new RegExp(`id="${form.wrap}"`),
      `id="${form.wrap}" harus ada di bodyHtml`
    );
    assert.match(
      src,
      new RegExp(`id="${form.box}"`),
      `id="${form.box}" harus ada di bodyHtml`
    );
  });

  test(`${form.file}: checkbox disembunyikan secara bawaan`, () => {
    const src = read(form.file);
    assert.match(
      src,
      new RegExp(`id="${form.wrap}" style="display:none"`),
      `${form.wrap} harus disembunyikan sampai jenisnya Dinas Luar Kota`
    );
  });

  test(`${form.file}: wrapper dibaca saat form diikat`, () => {
    const src = read(form.file);
    assert.match(
      src,
      new RegExp(`getElementById\\('${form.wrap}'\\)|querySelector\\('#${form.wrap}'\\)`),
      `${form.wrap} harus dibaca supaya bisa ditampilkan`
    );
  });

  test(`${form.file}: checkbox ikut terkirim sebagai use_vehicle`, () => {
    const src = read(form.file);
    assert.match(
      src,
      /use_vehicle/,
      'payload harus mengirim use_vehicle saat checkbox dicentang'
    );
  });
}

test('semua form pengajuan punya prefix id yang sama-sama terpasang', () => {
  // Kalau ada form pengajuan baru, tambahkan juga di daftar FORMS di atas.
  const found = [];
  for (const file of fs.readdirSync(PAGES)) {
    const src = read(file);
    if (/UseVehicle/.test(src)) found.push(file);
  }
  assert.deepEqual(found.sort(), FORMS.map((f) => f.file).sort());
});

test('pengajuan.js membaca needs_vehicle dari katalog server', () => {
  // Form admin memakai katalog dari /auth/meta, jadi needs_vehicle harus
  // diteruskan ke atribut data-vehicle pada <option>.
  const src = read('pengajuan.js');
  assert.match(src, /data-vehicle="/, 'option harus membawa atribut data-vehicle');
  assert.match(src, /s\.needs_vehicle/, 'needs_vehicle harus dibaca dari katalog');
  assert.match(
    src,
    /getAttribute\('data-vehicle'\) === '1'/,
    'status kendaraan dibaca dari atribut tersebut saat jenis berubah'
  );
});