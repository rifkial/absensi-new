'use strict';

/**
 * Tes validasi berkas bukti reimbursement.
 *
 * Aturan yang dijaga:
 *   - hanya JPG/JPEG dan PDF yang diterima
 *   - nama berkas dibuat server (tidak pernah dari user) dan ekstensi mengikuti tipe
 *   - PDF dibaca sebagai application/pdf, JPG sebagai image/jpeg
 *   - batas ukuran 5 MB
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const portal = require('../src/services/employeePortal');

const { ATTACHMENT_MIME, MAX_ATTACHMENT_BYTES, attachmentMimeOf, attachmentDownloadName } = portal;

test('hanya JPG/JPEG dan PDF yang diizinkan', () => {
  assert.deepEqual(Object.keys(ATTACHMENT_MIME).sort(), ['application/pdf', 'image/jpeg']);
  assert.equal(ATTACHMENT_MIME['image/jpeg'], '.jpg');
  assert.equal(ATTACHMENT_MIME['application/pdf'], '.pdf');
});

test('PNG dan WEBP ditolak untuk bukti reimburse', () => {
  // Berbeda dari selfie dinas luar yang boleh PNG/WEBP.
  assert.equal(ATTACHMENT_MIME['image/png'], undefined);
  assert.equal(ATTACHMENT_MIME['image/webp'], undefined);
});

test('ekstensi berkas mengikuti tipe yang diterima', () => {
  assert.equal(ATTACHMENT_MIME['image/jpeg'], '.jpg');
  assert.equal(ATTACHMENT_MIME['application/pdf'], '.pdf');
});

test('attachmentMimeOf membaca PDF dan JPG dengan benar', () => {
  assert.equal(attachmentMimeOf('abc-123.pdf'), 'application/pdf');
  assert.equal(attachmentMimeOf('abc-123.jpg'), 'image/jpeg');
  assert.equal(attachmentMimeOf('abc-123.JPG'), 'image/jpeg');
});

test('batas ukuran 5 MB', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 5 * 1024 * 1024);
});

test('nama unduhan disanitasi dari deskripsi pengajuan', () => {
  const name = attachmentDownloadName({
    description: 'Tilet bus Surabaya / Darmstadt ( urgently )',
    attachment: '1-123-abc.pdf',
  });

  assert.match(name, /\.pdf$/);
  assert.doesNotMatch(name, /[^A-Za-z0-9.-]/);
});

test('nama unduhan aman walau deskripsi kosong atau penuh simbol', () => {
  assert.match(
    attachmentDownloadName({ description: '', attachment: 'x.jpg' }),
    /^bukti\.jpg$/
  );
  assert.match(
    attachmentDownloadName({ description: '///', attachment: 'x.pdf' }),
    /^bukti\.pdf$/
  );
});

test('nama unduhan dipotong pada 80 karakter', () => {
  const name = attachmentDownloadName({
    description: 'a'.repeat(200),
    attachment: 'x.jpg',
  });

  assert.ok(name.length <= 84, `panjang nama terlalu besar: ${name.length}`);
});