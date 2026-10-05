'use strict';

const db = require('../db/pool');
const { badRequest, notFound, conflict, str, boolParam } = require('../utils/errors');
const { toDate, today, parse } = require('../utils/date');
const settingsService = require('./settings');

/**
 * Hari libur nasional + cuti bersama + hari libur tambahan dari admin.
 *
 * Data disimpan di tabel `holidays` sehingga rekap absensi tetap bisa dihitung
 * ulang dari database sendiri, tanpa bergantung pada koneksi internet.
 *
 * Urutan prioritas saat rekap:
 *   Jadwal per tanggal (day_type) > Hari libur > work_days shift > Global
 */

const KINDS = ['nasional', 'cuti_bersama', 'custom'];

const KIND_LABEL = {
  nasional: 'Libur Nasional',
  cuti_bersama: 'Cuti Bersama',
  custom: 'Libur Tambahan',
};

const SELECT = `
  id, holiday_date, name, kind, source, is_workday, note, created_by, created_at, updated_at
`;

/** Sumber data default (gratis, tanpa API key). */
const DEFAULT_SOURCES = [
  {
    label: 'Kemendesa',
    url: 'https://api.kemendesa.link/libur-nasional/api/holidays/{year}.json',
    parse: parseKemenDesa,
  },
  {
    label: 'api-hari-libur',
    url: 'https://api-hari-libur.vercel.app/api?year={year}',
    parse: parseHariLibur,
  },
];

// ---------------------------------------------------------------------------
// Baca
// ---------------------------------------------------------------------------

/** Daftar hari libur pada rentang tanggal (inklusif). */
async function listBetween(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end) throw badRequest('Rentang tanggal tidak valid.');
  if (start > end) throw badRequest('Tanggal awal harus lebih dulu dari tanggal akhir.');

  return db.queryAll(
    `SELECT ${SELECT} FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date ASC`,
    [start, end]
  );
}

/** Daftar hari libur satu tahun. */
async function listByYear(year) {
  const y = Number.parseInt(year, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw badRequest('Tahun tidak valid (harus antara 2000 dan 2100).');
  }
  return db.queryAll(
    `SELECT ${SELECT} FROM holidays WHERE YEAR(holiday_date) = ? ORDER BY holiday_date ASC`,
    [y]
  );
}

/** Satu hari libur pada tanggal tertentu, atau null. */
async function getByDate(date) {
  const d = toDate(date);
  if (!d) return null;
  return db.queryOne(`SELECT ${SELECT} FROM holidays WHERE holiday_date = ?`, [d]);
}

async function getOrFail(id) {
  const row = await db.queryOne(`SELECT ${SELECT} FROM holidays WHERE id = ?`, [id]);
  if (!row) throw notFound(`Hari libur dengan id ${id} tidak ditemukan.`);
  return row;
}

/**
 * Peta tanggal -> hari libur untuk satu rentang, dipakai rekap agar tidak
 * query database berulang untuk tanggal yang sama.
 */
async function mapForRange(from, to) {
  const rows = await listBetween(from, to);
  const map = new Map();
  for (const row of rows) {
    // Libur yang ditandai tetap hari kerja tidak otomatis menjadi hari libur.
    if (Number(row.is_workday) === 1) continue;
    map.set(row.holiday_date, row);
  }
  return map;
}

/** Apakah tanggal ini hari libur yang tidak ditimpa sebagai hari kerja? */
function isHoliday(map, date) {
  if (!map) return false;
  return map.has(date);
}

// ---------------------------------------------------------------------------
// Tulis (manual oleh admin/HR)
// ---------------------------------------------------------------------------

function normalize(payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.holiday_date !== undefined) {
    const date = toDate(payload.holiday_date);
    if (!date) throw badRequest('holiday_date wajib diisi dengan format YYYY-MM-DD.');
    data.holiday_date = date;
  }

  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 150 });
    if (!name) throw badRequest('name (nama hari libur) wajib diisi.');
    data.name = name;
  }

  if (!partial || payload.kind !== undefined) {
    const kind = String(payload.kind ?? 'custom').trim();
    if (!KINDS.includes(kind)) {
      throw badRequest(`kind tidak valid. Pilihan: ${KINDS.join(', ')}.`);
    }
    data.kind = kind;
  }

  if (payload.is_workday !== undefined) {
    const value = boolParam(payload.is_workday);
    if (value === null) throw badRequest('is_workday harus boolean.');
    data.is_workday = value ? 1 : 0;
  }

  if (payload.note !== undefined) {
    data.note = str(payload.note, { maxLength: 255 });
  }

  return data;
}

async function create(payload, actorId = null) {
  const data = normalize(payload);
  data.is_workday = data.is_workday ?? 0;
  data.source = 'manual';

  const existing = await getByDate(data.holiday_date);
  if (existing) {
    throw conflict(
      `Tanggal ${data.holiday_date} sudah terdaftar sebagai "${existing.name}". ` +
        'Ubah baris tersebut atau hapus dulu sebelum menambah baru.'
    );
  }

  const columns = Object.keys(data);
  const result = await db.execute(
    `INSERT INTO holidays (${columns.join(', ')}, created_by) VALUES (${columns.map(() => '?').join(', ')}, ?)`,
    [...columns.map((c) => data[c]), actorId]
  );

  invalidateCache();
  return getOrFail(result.insertId);
}

async function update(id, payload) {
  await getOrFail(id);
  const data = normalize(payload, { partial: true });

  if (Object.keys(data).length === 0) throw badRequest('Tidak ada field yang diubah.');

  if (data.holiday_date) {
    const clash = await db.queryOne(
      'SELECT id, name FROM holidays WHERE holiday_date = ? AND id <> ?',
      [data.holiday_date, Number(id)]
    );
    if (clash) {
      throw conflict(
        `Tanggal ${data.holiday_date} sudah dipakai oleh "${clash.name}". ` +
          'Satu tanggal hanya boleh punya satu hari libur.'
      );
    }
  }

  const columns = Object.keys(data);
  await db.execute(
    `UPDATE holidays SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => data[c]), id]
  );

  invalidateCache();
  return getOrFail(id);
}

async function remove(id) {
  const holiday = await getOrFail(id);
  await db.execute('DELETE FROM holidays WHERE id = ?', [id]);
  invalidateCache();
  return { deleted: true, holiday };
}

/** Hapus semua hari libur hasil sinkronisasi (manual tidak disentuh). */
async function removeSynced() {
  const result = await db.execute("DELETE FROM holidays WHERE source = 'sync'");
  invalidateCache();
  return Number(result.affectedRows || 0);
}

// ---------------------------------------------------------------------------
// Sinkronisasi dari API hari libur nasional
// ---------------------------------------------------------------------------

/** Bentuk {data:[{date,name,...}]} dari api.kemendesa.link. */
function parseKemenDesa(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => ({
      date: toDate(row.date),
      name: str(row.name, { maxLength: 150 }),
      kind: row.is_cuti_bersama ? 'cuti_bersama' : 'nasional',
    }))
    .filter((row) => row.date && row.name);
}

/** Bentuk {data:[{date,description}]} dari api-hari-libur. */
function parseHariLibur(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .map((row) => {
      const name = str(row.description ?? row.name, { maxLength: 150 });
      return {
        date: toDate(row.date),
        name,
        // Nama diawali "Cuti Bersama" menandai jenis cuti bersama.
        kind: /^cuti\s+bersama/i.test(String(name).trim()) ? 'cuti_bersama' : 'nasional',
      };
    })
    .filter((row) => row.date && row.name);
}

/** Ambil daftar libur satu tahun dari sumber yang diminta. */
async function fetchFromSource(source, year) {
  const url = source.url.replace('{year}', String(year));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'absensi-fingerprint/1.0' },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const payload = await res.json();
    const items = source.parse(payload);
    if (items.length === 0) throw new Error('respons tidak berisi data hari libur');
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sinkronkan hari libur nasional untuk satu tahun.
 *
 * Baris yang sudah ada tidak ditimpa kalau asalnya 'manual', sehingga
 * koreksi admin (mis. mengubah cuti bersama menjadi hari kerja) tidak
 * tertimpa saat sinkron ulang.
 */
async function syncYear(year) {
  const y = Number.parseInt(year, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw badRequest('Tahun tidak valid (harus antara 2000 dan 2100).');
  }

  const stored = await settingsService.getAll();
  const sources = DEFAULT_SOURCES;

  const errors = [];
  for (const source of sources) {
    let items = null;
    try {
      items = await fetchFromSource(source, y);
    } catch (err) {
      errors.push(`${source.label}: ${err.message}`);
      continue;
    }

    let inserted = 0;
    let updated = 0;
    let kept = 0;

    for (const item of items) {
      const existing = await getByDate(item.date);
      if (existing) {
        if (existing.source === 'manual') {
          kept += 1;
          continue;
        }
        await db.execute(
          `UPDATE holidays SET name = ?, kind = ?, source = 'sync', updated_at = NOW()
             WHERE holiday_date = ?`,
          [item.name, item.kind, item.date]
        );
        updated += 1;
      } else {
        await db.execute(
          `INSERT INTO holidays (holiday_date, name, kind, source, is_workday)
           VALUES (?, ?, ?, 'sync', 0)`,
          [item.date, item.name, item.kind]
        );
        inserted += 1;
      }
    }

    await settingsService.updateMany({ holiday_sync_last_at: today() }).catch(() => {});

    invalidateCache();
    return {
      year: y,
      source: source.label,
      total: items.length,
      inserted,
      updated,
      kept,
      message:
        `${items.length} hari libur tahun ${y} dari ${source.label}: ` +
        `${inserted} baru, ${updated} diperbarui, ${kept} dipertahankan (manual).`,
    };
  }

  throw badRequest(
    `Gagal mengambil data hari libur tahun ${y} dari semua sumber. ${errors.join(' | ')}`
  );
}

/** Sinkronkan beberapa tahun sekaligus (tahun ini sampai tahun depan). */
async function syncRange(fromYear, toYear) {
  const start = Number.parseInt(fromYear, 10);
  const end = Number.parseInt(toYear ?? fromYear, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw badRequest('Tahun tidak valid.');
  }
  if (start > end) throw badRequest('Tahun awal harus lebih dulu dari tahun akhir.');
  if (end - start > 5) throw badRequest('Sinkronisasi dibatasi maksimal 6 tahun sekaligus.');

  const results = [];
  for (let year = start; year <= end; year += 1) {
    results.push(await syncYear(year));
  }

  return {
    years: results.map((r) => r.year),
    results,
    message: results.map((r) => r.message).join(' '),
  };
}

/**
 * Sinkron otomatis bila sudah waktunya (dipanggil penjadwal).
 *
 * Returns null bila fiturnya dimatikan atau belum jatuh tempo, sehingga
 * pemanggil tidak perlu Logic tanggal sendiri.
 */
async function autoSyncIfDue({ now = today() } = {}) {
  const settings = await settingsService.getAll();
  if (!settingsService.boolSetting(settings.holiday_sync_enabled, false)) return null;

  const intervalDays = settingsService.intSetting(settings.holiday_sync_interval_days, 30);
  const lastAt = str(settings.holiday_sync_last_at, { maxLength: 10 });
  if (lastAt) {
    const diff = Math.round((parse(now) - parse(lastAt)) / 86400000);
    if (diff < intervalDays) return null;
  }

  const yearsAhead = settingsService.intSetting(settings.holiday_sync_years_ahead, 1);
  const thisYear = Number.parseInt(now.slice(0, 4), 10);

  return syncRange(thisYear, thisYear + yearsAhead);
}

/** Status sinkron untuk ditampilkan di UI. */
async function syncStatus() {
  const settings = await settingsService.getAll();
  return {
    enabled: settingsService.boolSetting(settings.holiday_sync_enabled, false),
    interval_days: settingsService.intSetting(settings.holiday_sync_interval_days, 30),
    years_ahead: settingsService.intSetting(settings.holiday_sync_years_ahead, 1),
    last_sync_at: str(settings.holiday_sync_last_at, { maxLength: 10 }) || null,
    sources: DEFAULT_SOURCES.map((s) => ({ label: s.label, url: s.url })),
  };
}

/** Ringkasan libur untuk dashboard / kalender. */
async function summary({ from, to } = {}) {
  const start = toDate(from) || today().slice(0, 8) + '01';
  const end = toDate(to) || `${start.slice(0, 4)}-12-31`;
  const rows = await listBetween(start, end);
  return {
    from: start,
    to: end,
    total: rows.length,
    by_kind: rows.reduce((acc, row) => {
      acc[row.kind] = (acc[row.kind] || 0) + 1;
      return acc;
    }, {}),
    data: rows,
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let rangeCache = null;
let rangeStamp = 0;
const RANGE_TTL_MS = 60000;

/**
 * Peta hari libur dengan cache singkat.
 *
 * Rekap harian selalu meminta rentang 1-2 bulan, jadi cache ini hampir selalu
 * kena dan database tidak perlu disentuh berulang kali.
 */
async function getHolidayMap(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  const key = `${start}:${end}`;

  if (rangeCache && rangeCache.key === key && Date.now() - rangeStamp < RANGE_TTL_MS) {
    return rangeCache.map;
  }

  const map = await mapForRange(start, end);
  rangeCache = { key, map };
  rangeStamp = Date.now();
  return map;
}

function invalidateCache() {
  rangeCache = null;
  rangeStamp = 0;
}

/** Bearing untuk UI: tanggal libur apa saja di sekitar hari ini. */
function upcoming(days = 30, from = today()) {
  const end = new Date(parse(`${from}T00:00:00`) || Date.now());
  end.setDate(end.getDate() + Math.max(1, days));
  const to = end.toISOString().slice(0, 10);
  return listBetween(from, to);
}

module.exports = {
  KINDS,
  KIND_LABEL,
  DEFAULT_SOURCES,
  listBetween,
  listByYear,
  getByDate,
  getOrFail,
  mapForRange,
  isHoliday,
  create,
  update,
  remove,
  removeSynced,
  syncYear,
  syncRange,
  autoSyncIfDue,
  syncStatus,
  summary,
  getHolidayMap,
  invalidateCache,
  upcoming,
};
