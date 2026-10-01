'use strict';

/**
 * Katalog pengajuan (izin / cuti / dinas).
 *
 * Form pengajuan karyawan bertingkat:
 *   1. Kategori  : cuti | izin | dinas
 *   2. Sub-jenis : pilihan yang menyesuaikan kategori
 *   3. Tanggal   : dinas dalam kota hanya boleh 1 hari,
 *                  dinas luar kota memakai rentang tanggal.
 *
 * Setiap sub-jenis menyimpan:
 *   - leave_type  : nilai enum yang disimpan di leave_requests.leave_type
 *   - status      : status rekap harian yang dipakai attendance.js
 *   - single_day  : true bila tanggal selesai wajib sama dengan tanggal mulai
 *   - needs_place : wajib mengisi tujuan/lokasi dinas
 *
 * Katalog ini adalah sumber kebenaran tunggal: validasi server, dropdown
 * frontend, dan pemetaan status rekap semuanya membaca dari sini.
 */

const CATEGORIES = [
  {
    key: 'cuti',
    label: 'Cuti',
    subtypes: [
      { key: 'cuti_tahunan', label: 'Cuti Tahunan', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_sakit', label: 'Cuti Sakit', leave_type: 'cuti', status: 'sakit' },
      { key: 'cuti_melahirkan', label: 'Cuti Melahirkan', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_menikah', label: 'Cuti Menikah', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_haji', label: 'Cuti Haji / Umrah', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_kematian_keluarga', label: 'Cuti Kematian Keluarga', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_alasan_penting', label: 'Cuti Alasan Penting', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_tanpa_bayar', label: 'Cuti Tanpa Bayar', leave_type: 'cuti', status: 'cuti' },
      { key: 'cuti_lainnya', label: 'Cuti Lainnya', leave_type: 'cuti', status: 'cuti' },
    ],
  },
  {
    key: 'izin',
    label: 'Izin',
    subtypes: [
      { key: 'izin_tidak_masuk', label: 'Izin Tidak Masuk', leave_type: 'izin', status: 'izin' },
      { key: 'izin_terlambat', label: 'Izin Terlambat', leave_type: 'izin', status: 'izin' },
      { key: 'izin_pulang_cepat', label: 'Izin Pulang Cepat', leave_type: 'izin', status: 'izin' },
      { key: 'izin_kebutuhan_pribadi', label: 'Izin Keperluan Pribadi', leave_type: 'izin', status: 'izin' },
      { key: 'izin_keluarga', label: 'Izin Mengurus Keluarga', leave_type: 'izin', status: 'izin' },
      { key: 'izin_administrasi', label: 'Izin Mengurus Administrasi / Dokumen', leave_type: 'izin', status: 'izin' },
      { key: 'izin_sakit', label: 'Izin Sakit', leave_type: 'sakit', status: 'sakit' },
      { key: 'izin_meninggal', label: 'Izin Kematian Keluarga', leave_type: 'izin_meninggal', status: 'izin' },
      { key: 'izin_lainnya', label: 'Izin Lainnya', leave_type: 'izin', status: 'izin' },
    ],
  },
  {
    key: 'dinas',
    label: 'Dinas',
    subtypes: [
      {
        key: 'dinas_dalam_kota',
        label: 'Dinas Dalam Kota',
        leave_type: 'dinas_dalam',
        status: 'dinas_dalam',
        single_day: true,
        needs_place: true,
      },
      {
        key: 'dinas_luar_kota',
        label: 'Dinas Luar Kota',
        leave_type: 'dinas_luar',
        status: 'dinas_luar',
        single_day: false,
        needs_place: true,
      },
    ],
  },
];

/** Sub-jenis yang wajib diisi tujuan/lokasi. */
const PLACE_SUBTYPES = ['dinas_dalam_kota', 'dinas_luar_kota'];

/** Semua leave_type yang boleh tersimpan (lama + baru). */
const LEAVE_TYPES = [
  'izin',
  'sakit',
  'cuti',
  'izin_meninggal',
  'dinas_luar',
  'dinas_dalam',
];

/** Peta sub-jenis -> leave_type, dipakai saat menerima payload dari form. */
const SUBTYPES = (() => {
  const map = new Map();
  for (const category of CATEGORIES) {
    for (const sub of category.subtypes) {
      map.set(sub.key, { ...sub, category: category.key });
    }
  }
  return map;
})();

/** Peta leave_type -> status rekap harian (fallback untuk data lama). */
const STATUS_BY_LEAVE_TYPE = {
  izin: 'izin',
  sakit: 'sakit',
  cuti: 'cuti',
  izin_meninggal: 'izin',
  dinas_luar: 'dinas_luar',
  dinas_dalam: 'dinas_dalam',
};

const CATEGORY_BY_LEAVE_TYPE = {
  izin: 'izin',
  sakit: 'izin',
  izin_meninggal: 'izin',
  cuti: 'cuti',
  dinas_luar: 'dinas',
  dinas_dalam: 'dinas',
};

function findCategory(key) {
  return CATEGORIES.find((c) => c.key === key) || null;
}

function findSubtype(key) {
  if (!key) return null;
  return SUBTYPES.get(String(key)) || null;
}

/**
 * Status rekap harian untuk sebuah pengajuan.
 * Sub-jenis (kalau ada) menang, lalu fallback ke leave_type untuk data lama.
 */
function statusForLeave(leaveType, subtypeKey) {
  const sub = findSubtype(subtypeKey);
  if (sub) return sub.status;
  return STATUS_BY_LEAVE_TYPE[leaveType] || 'izin';
}

/** Kategori pengajuan dari leave_type + sub-jenis (untuk tampilan). */
function categoryForLeave(leaveType, subtypeKey) {
  const sub = findSubtype(subtypeKey);
  if (sub) return sub.category;
  return CATEGORY_BY_LEAVE_TYPE[leaveType] || null;
}

/** Label yang mudah dibaca untuk disimpan di rekap harian. */
function labelForLeave(leaveType, subtypeKey) {
  const sub = findSubtype(subtypeKey);
  if (sub) return sub.label;
  const category = CATEGORY_BY_LEAVE_TYPE[leaveType];
  const cat = category ? findCategory(category) : null;
  return cat ? cat.label : String(leaveType || '').replace(/_/g, ' ');
}

/** Bentuk respons untuk dropdown frontend. */
function toPublicOptions() {
  return CATEGORIES.map((category) => ({
    key: category.key,
    label: category.label,
    subtypes: category.subtypes.map((sub) => ({
      key: sub.key,
      label: sub.label,
      single_day: Boolean(sub.single_day),
      needs_place: Boolean(sub.needs_place),
    })),
  }));
}

module.exports = {
  CATEGORIES,
  LEAVE_TYPES,
  PLACE_SUBTYPES,
  STATUS_BY_LEAVE_TYPE,
  CATEGORY_BY_LEAVE_TYPE,
  findCategory,
  findSubtype,
  statusForLeave,
  categoryForLeave,
  labelForLeave,
  toPublicOptions,
};
