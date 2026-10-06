'use strict';

const { badRequest, str } = require('../utils/errors');

/**
 * Katalog jenis biaya reimbursement.
 *
 * Mirip leaveCatalog: modul ini murni data + fungsi murni, tanpa DB dan tanpa
 * efek samping, supaya jadi satu-satunya sumber kebenaran untuk pilihan jenis
 * biaya (dipakai portal karyawan untuk dropdown dan server untuk validasi).
 *
 * Daftar ini sengaja dibuat umum, bukan per-divisi: reimburse dipakai untuk
 * biaya yang muncul di luar kegiatan rutin (transportasi, makan, penginapan,
 * ATK, dll). Karyawan yang butuh jenis di luar daftar ini memakai kategori
 * "lainnya" lalu menulis detailnya di kolom keterangan.
 */

const CATEGORIES = [
  { key: 'transportasi', label: 'Transportasi', needs_note: true },
  { key: 'makan', label: 'Makan / Konsumsi', needs_note: true },
  { key: 'penginapan', label: 'Penginapan', needs_note: true },
  { key: 'transportasi_barang', label: 'Pengiriman Barang', needs_note: true },
  { key: 'komunikasi', label: 'Komunikasi / Internet', needs_note: false },
  { key: 'atk', label: 'Alat Tulis / Perlengkapan', needs_note: false },
  { key: 'perawatan', label: 'Perawatan Kendaraan / Alat', needs_note: true },
  { key: 'pelatihan', label: 'Pelatihan / Kursus', needs_note: true },
  { key: 'lainnya', label: 'Lainnya', needs_note: true },
];

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

/** Batas nilai_amount, diselaraskan dengan DECIMAL(12,2) di database. */
const MAX_AMOUNT = 9_999_999_999.99;

/** Umur maximal reimbursement yang boleh diajukan (hari ke belakang). */
const MAX_BACKDATE_DAYS = 90;

/** Jumlah rincian dalam satu pengajuan (form general bisa berisi beberapa baris). */
const MAX_ITEMS = 20;

function findCategory(key) {
  if (!key) return null;
  return CATEGORIES.find((c) => c.key === String(key)) || null;
}

function labelFor(key) {
  const cat = findCategory(key);
  return cat ? cat.label : String(key || '').replace(/_/g, ' ');
}

function isValidKey(key) {
  return findCategory(key) !== null;
}

/** Bentuk respons untuk dropdown frontend. */
function toPublicOptions() {
  return CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    needs_note: Boolean(c.needs_note),
  }));
}

/**
 * Ambil daftar rincian dari payload.
 *
 * Ada dua bentuk masukan yang harus ditangani:
 *   - array biasa, mis. dari api.post() dengan body JSON
 *   - STRING berisi JSON, mis. dari FormData. FormData hanya bisa mengirim
 *     nilai string, jadi frontend wajib JSON.stringify(Array) sebelum
 *     di-append. Tanpa penanganan di sini, payload string akan dianggap
 *     "satu rincian" yang tidak punya keterangan, dan server menolak form
 *     yang sebenarnya sudah terisi lengkap.
 */
function toItemList(payload = {}) {
  let items = payload.items;

  if (typeof items === 'string') {
    const text = items.trim();
    if (text === '') return [{ ...payload }];

    try {
      items = JSON.parse(text);
    } catch {
      throw badRequest('Rincian biaya tidak dapat dibaca. Muat ulang halaman lalu coba lagi.');
    }
  }

  // Objek tunggal dengan {description, amount} juga sah.
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    return [items];
  }

  if (Array.isArray(items) && items.length > 0) return items;

  return [{ ...payload }];
}

/**
 * Normalisasi rincian biaya dari form.
 *
 * Diterima dua bentuk masukan:
 *   - items: [{ description, amount, category? }, ...] (beberapa baris)
 *   - atau bentuk sederhana: { description, amount, category }
 *
 * Total selalu dihitung ulang di sini; nilai total yang dikirim klien
 * diabaikan supaya tidak bisa dimanipulasi. Fungsi murni (tidak menyentuh DB)
 * supaya aturan ini bisa diuji tanpa database.
 *
 * @throws {AppError} badRequest bila ada baris tidak valid.
 */
function normalizeItems(payload = {}) {
  const raw = toItemList(payload);

  if (raw.length > MAX_ITEMS) {
    throw badRequest(`Maksimal ${MAX_ITEMS} rincian per pengajuan.`);
  }

  const items = [];
  for (const entry of raw) {
    const description = str(entry?.description, { maxLength: 500 });
    if (!description) throw badRequest('Keterangan tiap rincian wajib diisi.');

    const amount = Number(entry?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest(
        `Jumlah untuk "${description}" tidak valid. Isi angka lebih besar dari nol ` +
          '(tanpa titik pemisah ribuan atau koma desimal).'
      );
    }
    if (amount > MAX_AMOUNT) {
      throw badRequest(
        `Jumlah untuk "${description}" melebihi batas ${MAX_AMOUNT.toLocaleString('id-ID')}.`
      );
    }

    // Kategori boleh diisi per rincian; kalau kosong pakai kategori overall.
    const categoryKey = String(entry?.category ?? payload.category ?? '').trim();
    if (categoryKey && !isValidKey(categoryKey)) {
      throw badRequest(
        `Jenis biaya "${categoryKey}" tidak dikenal. ` +
          `Pilihan: ${CATEGORIES.map((c) => c.key).join(', ')}.`
      );
    }

    // Pembulatan ke sen terdekat; DECIMAL(12,2) akan memotong lebih dari dua
    // desimal kalau tidak dibulatkan di sini.
    items.push({
      description,
      amount: Math.round(amount * 100) / 100,
      category: categoryKey || null,
    });
  }

  if (items.length === 0) throw badRequest('Minimal satu rincian biaya wajib diisi.');

  const total = Math.round(items.reduce((sum, it) => sum + it.amount, 0) * 100) / 100;
  if (total > MAX_AMOUNT) {
    throw badRequest(
      `Total pengajuan melebihi batas ${MAX_AMOUNT.toLocaleString('id-ID')}.`
    );
  }

  return { items, total };
}

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  MAX_AMOUNT,
  MAX_BACKDATE_DAYS,
  MAX_ITEMS,
  findCategory,
  labelFor,
  isValidKey,
  toPublicOptions,
  normalizeItems,
};