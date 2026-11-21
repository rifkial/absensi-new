'use strict';

/**
 * Codec untuk protokol FkWeb (Fingerspot Revo mode Internet).
 *
 * Format body: u32 LE (panjang JSON+NUL) | JSON UTF-8 + NUL | [u32 LE panjang | biner]...
 * Semua angka little-endian. Lihat docs/protokol.md pada proyek freedom-finger.
 */

function encodeBody(json, bins = []) {
  const text = typeof json === 'string' ? json : JSON.stringify(json ?? '');
  if (text === '' || text === 'null' || text === 'undefined') {
    // JSON kosong -> body kosong (perintah tanpa parameter).
    if (text === '' ) return Buffer.alloc(0);
  }
  // Jangan kirim "null"/"undefined" literal; perlakukan sebagai kosong.
  const normalized = (text === 'null' || text === 'undefined') ? '' : text;
  if (normalized === '') return Buffer.alloc(0);

  const jsonBuf = Buffer.from(normalized, 'utf8');
  const textLen = jsonBuf.length + 1;
  const chunks = [Buffer.alloc(4)];
  chunks[0].writeUInt32LE(textLen, 0);
  const out = [chunks[0], jsonBuf, Buffer.from([0])];
  for (const b of bins || []) {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b || []);
    const h = Buffer.alloc(4);
    h.writeUInt32LE(buf.length, 0);
    out.push(h, buf);
  }
  return Buffer.concat(out);
}

function decodeBody(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (buffer.length === 0) return { json: '', bins: [] };

  const n = buffer.length >= 4 ? buffer.readUInt32LE(0) : 0;
  if (n === 0 || n > buffer.length - 4) {
    // Bukan format FkWeb: simpan mentah.
    return { json: '', bins: [buffer] };
  }

  const jsonBuf = buffer.subarray(4, 4 + n);
  const json = jsonBuf.toString('utf8').replace(/\0+$/, '');

  const bins = [];
  let p = 4 + n;
  while (p + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(p);
    const start = p + 4;
    const end = Math.min(start + len, buffer.length);
    bins.push(buffer.subarray(start, end));
    p = start + len;
  }

  return { json, bins };
}

/** Ubah string 14 digit "YYYYMMDDhhmmss" -> "YYYY-MM-DD HH:mm:ss" (jam dinding). */
function parseFkTime(value) {
  const s = String(value || '').trim();
  if (!/^\d{14}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
}

/** Jam dinding sekarang dalam format 14 digit. Mesin Revo memakai WIB (UTC+7). */
function fkNow(offsetMinutes = 7 * 60) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  const p = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Ubah "YYYYMMDDhhmmss" menjadi epoch ms dengan zona eksplisit (default WIB). */
function parseFkTimeToMillis(value, offsetMinutes = 7 * 60) {
  const s = String(value || '').trim();
  if (!/^\d{14}$/.test(s)) return null;
  const ms = Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14))
  ) - offsetMinutes * 60 * 1000;
  return Number.isNaN(ms) ? null : ms;
}

/** Map kode verifikasi FkWeb (nibble) -> nilai verify_mode skema DB. */
function mapVerifyCode(code) {
  const kinds = [];
  for (let i = 7; i >= 0; i -= 1) {
    const nibble = (code >>> (i * 4)) & 0x0f;
    if (nibble === 0) break;
    kinds.push(nibble);
  }
  const first = kinds.length > 0 ? kinds[0] : 0;
  // 1=jari->0, 2=password->2, 3=kartu->1, 4=wajah->3
  if (first === 1) return 0;
  if (first === 2) return 2;
  if (first === 3) return 1;
  if (first === 4) return 3;
  return 0;
}

/** Parse satu record log 48 byte. */
function parseLogRecord(buf) {
  if (!buf || buf.length < 48) return null;
  const pin = buf.toString('ascii', 0, 32).replace(/\0.*$/, '').trim();
  if (!pin) return null;

  const second = buf[35];
  const w = buf.readUInt32LE(36);
  const year = ((w >>> 2) & 0x3ff) + 1900;
  const month = (w >>> 12) & 0x0f;
  const day = (w >>> 16) & 0x1f;
  const hour = (w >>> 21) & 0x1f;
  const minute = (w >>> 26) & 0x3f;

  const pad = (n) => String(n).padStart(2, '0');
  const logTime = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;

  const ioMode = buf.readUInt32LE(40);
  const verifyMode = buf.readUInt32LE(44);

  return {
    deviceUserId: pin,
    logTime,
    logDate: logTime.slice(0, 10),
    logState: (ioMode >>> 24) === 2 ? 1 : 0,
    verifyMode: mapVerifyCode(verifyMode),
    workCode: '',
  };
}

/** Parse array record log dari buffer, ukuran record tetap. */
function parseLogRecords(buf, recordSize = 48) {
  const out = [];
  if (!buf || buf.length === 0) return out;
  const size = recordSize > 0 ? recordSize : 48;
  for (let i = 0; i + size <= buf.length; i += size) {
    const rec = parseLogRecord(buf.subarray(i, i + size));
    if (rec) out.push(rec);
  }
  return out;
}

/** Parse satu record user 36 byte. */
function parseUserEntry(buf) {
  if (!buf || buf.length < 36) return null;
  const pin = buf.toString('ascii', 0, 24).replace(/\0.*$/, '').trim();
  if (!pin) return null;
  return {
    deviceUserId: pin,
    manager: buf[32] === 1,
    active: buf[33] === 1,
    enrolled: buf[34],
  };
}

/** Parse array record user dari buffer. */
function parseUserEntries(buf, recordSize = 36) {
  const out = [];
  if (!buf || buf.length === 0) return out;
  const size = recordSize > 0 ? recordSize : 36;
  for (let i = 0; i + size <= buf.length; i += size) {
    const u = parseUserEntry(buf.subarray(i, i + size));
    if (u) out.push(u);
  }
  return out;
}

module.exports = {
  encodeBody,
  decodeBody,
  parseFkTime,
  parseFkTimeToMillis,
  fkNow,
  mapVerifyCode,
  parseLogRecord,
  parseLogRecords,
  parseUserEntry,
  parseUserEntries,
};