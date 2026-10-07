'use strict';

/**
 * Tes helper backup/restore (src/services/backup.js).
 *
 * Tanpa database & tanpa Chromium: hanya parser .sql dan validasi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const backup = require('../src/services/backup');

test('splitStatements memecah aman, abaikan komentar, hormati string', () => {
  const sql = [
    '-- komentar backup',
    "INSERT INTO `a` (`name`) VALUES ('titik;koma;');",
    "INSERT INTO `a` (`name`) VALUES ('petik\\' aman');",
    '# komentar hash',
    'SET FOREIGN_KEY_CHECKS=0;',
    'TRUNCATE TABLE `a`;',
  ].join('\n');
  const parts = backup.splitStatements(sql);
  assert.ok(parts.some((s) => s.includes('titik;koma;')), 'string berisi ; tidak boleh pecah');
  assert.ok(parts.some((s) => s.includes('TRUNCATE TABLE')), 'TRUNCATE ikut dieksekusi');
  assert.ok(!parts.some((s) => s.includes('komentar backup')), 'komentar dibuang');
  assert.ok(!parts.some((s) => s.includes('FOREIGN_KEY_CHECKS')), 'SET FK internal dibuang');
});

test('assertBackupSql menolak file bukan dump', () => {
  assert.throws(() => backup.assertBackupSql('kecil'), /terlalu kecil/);
  assert.throws(
    () => backup.assertBackupSql('x'.repeat(200) + ' tanpa struktur dump ' + 'y'.repeat(200)),
    /bukan dump/
  );
  const valid = `-- valid\nCREATE TABLE \`a\` (id INT);\nINSERT INTO \`a\` (id) VALUES (1);\n${' '.repeat(200)}`;
  assert.ok(backup.assertBackupSql(valid).includes('CREATE TABLE'));
});
