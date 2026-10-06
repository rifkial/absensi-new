'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Surat Perjalanan Dinas (SPD) + transportasi.
 * Non-trivial logic disini: normalisasi input + nomor default.
 * ponytail: nomor default format SPD/{id}/{MM}/{YYYY}; upgrade ke
 * penomoran per-bulan/urutan bila butuh arsip resmi.
 */

function normalizeTravel(payload = {}) {
  const out = {};
  if (payload.transport !== undefined) {
    const v = String(payload.transport || '').trim().slice(0, 150);
    out.transport = v || null;
  }
  if (payload.travel_letter_no !== undefined) {
    const v = String(payload.travel_letter_no || '').trim().slice(0, 60);
    out.travel_letter_no = v || null;
  }
  return out;
}

function defaultLetterNo(id, dateStr) {
  const d = String(dateStr || '').slice(0, 10) || '0000-00-00';
  const mm = d.slice(5, 7) || '00';
  const yyyy = d.slice(0, 4) || '0000';
  return `SPD/${String(id).padStart(4, '0')}/${mm}/${yyyy}`;
}

function isDinas(row) {
  if (!row) return false;
  return row.leave_type === 'dinas_luar' || row.leave_type === 'dinas_dalam';
}

function assertApprovable(row) {
  if (!row) throw badRequest('Pengajuan tidak ditemukan.');
  if (!isDinas(row)) throw badRequest('Surat perjalanan hanya untuk pengajuan dinas.');
  if (row.status !== 'approved') throw badRequest('Surat perjalanan hanya bisa dibuat setelah dinas disetujui.');
}

module.exports = { normalizeTravel, defaultLetterNo, isDinas, assertApprovable };
