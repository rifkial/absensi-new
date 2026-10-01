'use strict';

const ExcelJS = require('exceljs');

const db = require('../../db/pool');
const { persistLogs } = require('../zkteco4370/adapter');
const { toDateTime, toDate, normalizeMachineTime } = require('../../utils/date');

/**
 * Adapter impor manual dari file hasil download mesin fingerprint.
 *
 * Format file dari mesin berbeda-beda antar merek/firmware. Yang paling umum:
 *   - kolom dipisah TAB (log .txt dari sebagian ZKTeco)
 *   - kolom dipisah koma/semicolon (export CSV/Excel)
 *   - header multilingual, kadang tanpa header sama sekali
 *
 * Strategi: coba deteksi header dari baris pertama. Bila tidak dikenali,
 * gunakan asumsi urutan: PIN, Nama, Waktu, Status, Verify, WorkCode.
 */

/** Sinonim header yang kami definisikan, lowercase tanpa spasi/garis. */
const HEADER_ALIASES = {
  pin: ['pin', 'userid', 'userId'.toLowerCase(), 'id', 'no', 'nopegawai', 'employeeid', 'employeeid'.toLowerCase(), 'noemployee', 'cardno', 'badgeno', 'uid'],
  name: ['name', 'nama', 'employeename', 'employe', 'namakaryawan', 'fullname'],
  time: ['datetime', 'time', 'punchtime', 'tstamp', 'tanggal', 'waktu', 'absen', 'checkintime', 'logtime', 'date'],
  date: ['date', 'tanggal', 'day'],
  state: ['state', 'status', 'logstate', 'absenstatus', 'jenis', 'keterangan', 'inout', 'inoutmode'],
  verify: ['verify', 'verifymode', 'mode', 'metode', 'caraabsen', 'sumber'],
  workCode: ['workcode', 'kodekerja', 'kode'],
  department: ['department', 'departemen', 'dept', 'unit', 'divisi', 'bagian'],
};

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Deteksi delimiter dari beberapa baris pertama. */
function detectDelimiter(sample) {
  const candidates = ['\t', ';', ',', '|'];
  const lines = sample.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 10);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    const counts = lines.map((line) => line.split(delim).length - 1);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (avg < 1) continue;
    const consistent = counts.every((c) => c === Math.round(avg));
    const score = avg + (consistent ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Parser CSV sederhana yang menangani kutip dan line break di dalam sel. */
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/** Cari indeks kolom berdasarkan alias header. */
function mapColumns(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const map = {};

  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const index = normalized.findIndex((h) => aliases.includes(h));
    if (index >= 0) map[key] = index;
  }

  return map;
}

/**
 * Parse isi file menjadi daftar log mentah.
 * `options` bisa berisi { deviceUserIdColumn, defaultDeviceId } untuk file
 * yang tidak punya kolom PIN.
 */
function parseRows(rows, options = {}) {
  if (rows.length === 0) return { logs: [], mapping: {}, warnings: ['File kosong.'] };

  const warnings = [];
  let headerIndex = 0;
  let mapping = mapColumns(rows[0]);

  const hasHeader = Object.keys(mapping).length >= 2 && mapping.pin !== undefined;
  if (!hasHeader) {
    // Asumsi urutan kolom standar: PIN, Nama, Waktu, Status, Verify, WorkCode
    mapping = { pin: 0, name: 1, time: 2, state: 3, verify: 4, workCode: 5 };
    headerIndex = -1;
    warnings.push('Header tidak dikenali, memakai urutan kolom asumsi: PIN, Nama, Waktu, Status, Verify, WorkCode.');
  }

  if (mapping.time === undefined) {
    throw new Error('Kolom waktu absen tidak ditemukan pada file. Pastikan ada kolom "Date Time" atau "Waktu".');
  }

  const logs = [];
  let skipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const get = (key) => (mapping[key] !== undefined ? String(row[mapping[key]] ?? '').trim() : '');

    let pin = get('pin') || (options.deviceUserId ? String(options.deviceUserId) : '');
    if (pin === '') {
      skipped += 1;
      continue;
    }

    // Gabungkan kolom tanggal + waktu bila keduanya terpisah.
    let timeRaw = get('time');
    if (mapping.date !== undefined && mapping.date !== mapping.time) {
      const dateRaw = get('date');
      if (dateRaw && !/^\d{4}-\d{2}-\d{2}/.test(timeRaw)) {
        timeRaw = `${dateRaw} ${timeRaw}`;
      }
    }
    if (options.defaultDate && !/^\d{4}/.test(timeRaw)) {
      timeRaw = `${options.defaultDate} ${timeRaw}`;
    }

    const normalized = normalizeMachineTime(timeRaw);
    const logTime = toDateTime(normalized);
    if (!logTime) {
      skipped += 1;
      continue;
    }

    // Buang tanggal tidak masuk akal (mis. 1970 karena format salah).
    if (logTime < '2000-01-01' || logTime > '2099-12-31') {
      skipped += 1;
      continue;
    }

    logs.push({
      deviceUserId: pin,
      logTime,
      logDate: toDate(logTime),
      logState: parseIntSafe(get('state'), 0),
      verifyMode: parseIntSafe(get('verify'), 0),
      workCode: get('workCode') || '',
      name: get('name'),
    });
  }

  if (skipped > 0) {
    warnings.push(`${skipped} baris dilewati karena PIN atau tanggal tidak valid.`);
  }

  return { logs, mapping, warnings };
}

function parseIntSafe(value, fallback) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Baca buffer file menjadi array-of-array rows (CSV/TXT/XLSX). */
async function readRows(buffer, filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();

  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];

    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values;
      const cells = [];
      for (let i = 1; i < values.length; i += 1) {
        const cell = values[i];
        cells.push(cellToString(cell));
      }
      if (cells.some((c) => c !== '')) rows.push(cells);
    });
    return rows;
  }

  const text = decodeText(buffer);
  const delimiter = detectDelimiter(text.slice(0, 4000));
  return parseCsv(text, delimiter);
}

/** Deteksi encoding file: BOM UTF-8, UTF-16, atau fallback latin1. */
function decodeText(buffer) {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return require('node:buffer').swap16(buffer.subarray(2)).toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  // Deteksi karakter non-ASCII yang sering muncul => kemungkinan Windows-1252.
  let suspicious = 0;
  const sample = buffer.subarray(0, 4096);
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] > 0x7f) suspicious += 1;
  }
  return suspicious / Math.max(1, sample.length) > 0.02
    ? buffer.toString('latin1')
    : buffer.toString('utf8');
}

function cellToString(cell) {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') {
    if (cell instanceof Date) {
      const p = (n) => String(n).padStart(2, '0');
      return `${cell.getFullYear()}-${p(cell.getMonth() + 1)}-${p(cell.getDate())} ${p(cell.getHours())}:${p(cell.getMinutes())}:${p(cell.getSeconds())}`;
    }
    if ('text' in cell) return String(cell.text);
    if ('result' in cell) return String(cell.result);
    if ('richText' in cell) return cell.richText.map((r) => r.text).join('');
  }
  return String(cell);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const csvAdapter = {
  protocol: 'csv',
  label: 'Impor file manual (CSV / XLSX)',
  description:
    'Unduh log dari menu mesin (USB / Download log), lalu unggah file-nya di sini. ' +
    'Berguna saat mesin tidak bisa dihubungkan ke jaringan sama sekali.',

  async test() {
    return {
      ok: true,
      message: 'Mode impor file tidak memerlukan koneksi ke mesin.',
    };
  },

  async sync() {
    return {
      ok: true,
      fetched: 0,
      inserted: 0,
      duplicated: 0,
      unmatched: 0,
      message: 'Gunakan menu Impor File untuk mengunggah log dari mesin.',
    };
  },

  /**
   * Simpan baris hasil parsing file ke DB.
   * deviceId boleh null bila pengguna mengimpor tanpa memilih perangkat.
   */
  async import({ buffer, filename, deviceId = null, sourceDeviceUserId = null, defaultDate = null }) {
    const rows = await readRows(buffer, filename);
    const { logs, mapping, warnings } = parseRows(rows, {
      deviceUserId: sourceDeviceUserId,
      defaultDate,
    });

    if (logs.length === 0) {
      return {
        ok: false,
        inserted: 0,
        fetched: 0,
        message: 'Tidak ada baris absensi valid pada file.',
        warnings,
      };
    }

    const result = await persistLogs({
      deviceId: deviceId || null,
      logs,
      source: 'import',
    });

    return {
      ok: true,
      ...result,
      mapping,
      warnings,
      message: `${result.inserted} log baru diimpor, ${result.duplicated} duplikat, ${result.unmatched} PIN tidak terdaftar.`,
    };
  },

  /** Pratinjau: parse file tanpa menyimpan, supaya bisa dicek dulu oleh pengguna. */
  async preview({ buffer, filename, sourceDeviceUserId = null, defaultDate = null, limit = 20 }) {
    const rows = await readRows(buffer, filename);
    const { logs, mapping, warnings } = parseRows(rows, {
      deviceUserId: sourceDeviceUserId,
      defaultDate,
    });

    const pins = [...new Set(logs.map((l) => l.deviceUserId))];
    const matched = await countKnownPins(pins);

    return {
      ok: true,
      totalRows: rows.length,
      validRows: logs.length,
      uniquePins: pins.length,
      knownPins: matched,
      unknownPins: pins.length - matched,
      columns: mapping,
      warnings,
      sample: logs.slice(0, limit),
    };
  },
};

async function countKnownPins(pins) {
  if (pins.length === 0) return 0;
  const placeholders = pins.slice(0, 500).map(() => '?').join(', ');
  return Number(
    (await db.queryScalar(`SELECT COUNT(DISTINCT device_user_id) FROM employees WHERE device_user_id IN (${placeholders})`, pins.slice(0, 500))) || 0
  );
}

module.exports = { adapter: csvAdapter, parseRows, readRows, parseCsv, detectDelimiter };
