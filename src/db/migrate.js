'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../config');
const { applyUpgrades } = require('./upgrades');

/**
 * Jalankan db/schema.sql.
 * Skema ditulis Idempoten (IF NOT EXISTS) sehingga aman dijalankan berulang kali.
 */
async function migrate() {
  const schemaPath = path.join(config.root, 'db', 'schema.sql');
  const sql = await fs.readFile(schemaPath, 'utf8');

  // Koneksi TANPA memilih database dulu, supaya script bisa membuat database
  // tersebut bila belum ada.
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  try {
    const dbName = config.db.database;
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
      throw new Error(`Nama database tidak valid: ${dbName}`);
    }

    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`[migrate] Database "${dbName}" siap.`);

    await conn.query(`USE \`${dbName}\``);

    // Upgrade instalasi lama DULU, karena schema.sql menambahkan FK baru di akhir
    // dan akan gagal bila kolom app_users.employee_id belum ada.
    await applyUpgrades(conn);

    await conn.query(sql);
    console.log('[migrate] Skema tabel & view berhasil diterapkan.');

    // Terapkan timezone session agar NOW()/CURDATE() konsisten dengan TZ aplikasi
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    await conn.query(`SET time_zone = '${tz}'`);
    console.log(`[migrate] Timezone session diset ke ${tz}.`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('[migrate] Selesai.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] GAGAL:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
