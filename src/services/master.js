'use strict';

/**
 * Data master: unit kerja (divisi/departemen) dan jabatan.
 *
 * Keduanya adalah referensi sederhana (kode + nama) yang dipakai sebagai
 * pilihan dropdown di form karyawan, filter laporan/absensi, dan jadwal massal.
 * Kode bersifat unik dan tidak dapat diubah setelah dibuat supaya riwayat data
 * lama tetap terbaca; nama boleh diperbarui.
 */

const db = require('../db/pool');
const { badRequest, notFound, conflict, str } = require('../utils/errors');

const TABLES = {
  departments: { label: 'unit kerja', codeLabel: 'Kode Unit' },
  positions: { label: 'jabatan', codeLabel: 'Kode Jabatan' },
};

function tableConfig(kind) {
  const config = TABLES[kind];
  if (!config) throw badRequest(`Jenis data master tidak dikenal: ${kind}`);
  return config;
}

async function list(kind) {
  const { label } = tableConfig(kind);
  const idColumn = kind === 'departments' ? 'department_id' : 'position_id';
  const rows = await db.queryAll(
    `SELECT m.id, m.code, m.name, m.created_at,
            (SELECT COUNT(*) FROM employees e WHERE e.${idColumn} = m.id) AS employee_count
       FROM ${kind} m
      ORDER BY m.name ASC, m.id ASC`
  );
  return rows.map((row) => ({ ...row, usage: Number(row.employee_count), label }));
}

async function getById(kind, id) {
  const row = await db.queryOne(`SELECT id, code, name FROM ${kind} WHERE id = ?`, [id]);
  return row || null;
}

async function getOrFail(kind, id) {
  const row = await getById(kind, id);
  if (!row) throw notFound(`${tableConfig(kind).label} dengan id ${id} tidak ditemukan.`);
  return row;
}

async function getByCode(kind, code) {
  return db.queryOne(`SELECT id, code, name FROM ${kind} WHERE code = ?`, [String(code).trim()]);
}

/** Validasi & normalisasi payload. Kode wajib unik, nama wajib diisi. */
function normalize(kind, payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.code !== undefined) {
    const code = str(payload.code, { maxLength: 20 });
    if (!code) throw badRequest('code wajib diisi.');
    data.code = code.toUpperCase();
  }

  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 100 });
    if (!name) throw badRequest('name wajib diisi.');
    data.name = name;
  }

  return data;
}

async function create(kind, payload) {
  const data = normalize(kind, payload);

  const existing = await getByCode(kind, data.code);
  if (existing) throw conflict(`Kode "${data.code}" sudah dipakai.`);

  const result = await db.execute(
    `INSERT INTO ${kind} (code, name) VALUES (?, ?)`,
    [data.code, data.name]
  );

  return getById(kind, result.insertId);
}

async function update(kind, id, payload) {
  await getOrFail(kind, id);

  // Kode tidak boleh diubah: kode dipakai sebagai identitas historis pada
  // laporan dan ekspor yang sudah tersimpan.
  if (payload.code !== undefined) {
    throw badRequest('Kode tidak dapat diubah. Buat data baru bila kode berbeda.');
  }

  const data = normalize(kind, payload, { partial: true });
  delete data.code;

  if (Object.keys(data).length === 0) throw badRequest('Tidak ada field yang diubah.');

  await db.execute(
    `UPDATE ${kind} SET name = ? WHERE id = ?`,
    [data.name, id]
  );

  return getById(kind, id);
}

async function remove(kind, id) {
  const row = await getOrFail(kind, id);

  const usage = await db.queryScalar(
    `SELECT COUNT(*) AS total FROM employees WHERE ${kind === 'departments' ? 'department_id' : 'position_id'} = ?`,
    [id]
  );

  if (Number(usage) > 0) {
    throw conflict(
      `${tableConfig(kind).label} "${row.name}" masih dipakai oleh ${usage} karyawan sehingga tidak bisa dihapus.`
    );
  }

  await db.execute(`DELETE FROM ${kind} WHERE id = ?`, [id]);
  return { deleted: true, kind, row };
}

module.exports = {
  TABLES,
  list,
  getById,
  getOrFail,
  create,
  update,
  remove,
};
