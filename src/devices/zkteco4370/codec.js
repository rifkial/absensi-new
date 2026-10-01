'use strict';

const {
  COMMANDS,
  COMMAND_NAMES,
  USHRT_MAX,
  MAGIC,
  PREFIX_LENGTH,
  PAYLOAD_HEADER_LENGTH,
  FRAME_HEADER_LENGTH,
  RECORD_SIZE,
  ATTENDANCE_OFFSET,
  USER_OFFSET,
} = require('./constants');

/** Zero-pad angka jadi string heksa length 2. */
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Checksum ZKTeco: jumlahkan setiap WORD 16-bit little-endian modulo 65535,
 * lalu kembalikan 65535 - sum - 1.
 *
 * `buffer` harus berisi payload header 8 byte (checksum masih 0) + data.
 */
function checksum(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    if (i === buffer.length - 1) {
      sum += buffer[i];
    } else {
      sum += buffer.readUInt16LE(i);
    }
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * Bentuk satu frame TCP lengkap (prefix 8 byte + payload header 8 byte + data).
 *
 * Catatan quirk: kedua referensi implementasi menuliskan replyId lalu menaikkan
 * nilainya SEBELUM frame dikirim, sehingga yang benar-benar di-wire adalah
 * replyId + 1. Kita meniru perilaku itu agar kompatibel dengan mesin.
 */
function buildFrame(command, sessionId, replyId, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  const payload = Buffer.alloc(PAYLOAD_HEADER_LENGTH + body.length);

  payload.writeUInt16LE(command & USHRT_MAX, 0);
  payload.writeUInt16LE(0, 2); // placeholder checksum
  payload.writeUInt16LE(sessionId & USHRT_MAX, 4);
  payload.writeUInt16LE(replyId & USHRT_MAX, 6);
  body.copy(payload, PAYLOAD_HEADER_LENGTH);

  payload.writeUInt16LE(checksum(payload), 2);
  payload.writeUInt16LE((replyId + 1) % USHRT_MAX, 6);

  const prefix = Buffer.alloc(PREFIX_LENGTH);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt16LE(payload.length, 4);

  return Buffer.concat([prefix, payload]);
}

/** Baca header frame (butuh minimal 8 byte). */
function decodeFrameHeader(buffer) {
  const payloadLength = buffer.readUInt16LE(4);
  const payload = buffer.subarray(PREFIX_LENGTH, FRAME_HEADER_LENGTH);
  return {
    payloadLength,
    totalLength: PREFIX_LENGTH + payloadLength,
    command: payload.readUInt16LE(0),
    checksum: payload.readUInt16LE(2),
    sessionId: payload.readUInt16LE(4),
    replyId: payload.readUInt16LE(6),
  };
}

function isValidMagic(buffer) {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(MAGIC);
}

function isEventFrame(buffer) {
  if (!isValidMagic(buffer) || buffer.length < FRAME_HEADER_LENGTH) return false;
  const header = decodeFrameHeader(buffer);
  const payload = buffer.subarray(FRAME_HEADER_LENGTH);
  // Event realtime punya bentuk: CMD_REG_EVENT dengan field event di offset 4
  // dari payload (setelah payload header).
  const eventFlag = payload.length >= 4 ? payload.readUInt16LE(4) : 0;
  return header.command === COMMANDS.CMD_REG_EVENT && eventFlag === COMMANDS.EF_ATTLOG;
}

function commandName(command) {
  return COMMAND_NAMES[command] || `CMD_UNKNOWN(${command})`;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/** Buffer -> string ASCII, potong di byte NUL pertama. */
function readAscii(buffer, encoding = 'ascii') {
  if (!buffer || buffer.length === 0) return '';
  let end = buffer.indexOf(0);
  if (end === -1) end = buffer.length;
  return buffer.subarray(0, end).toString(encoding).trim();
}

/**
 * Tulis string ke buffer dengan padding NUL.
 * Nama non-ASCII di-decoded sebagai latin1 supaya byte-nya tidak rusak saat
 * dikirim balik ke mesin.
 */
function writeAscii(buffer, offset, length, value) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'latin1');
  const written = Math.min(bytes.length, length);
  bytes.copy(buffer, offset, 0, written);
  buffer.fill(0, offset + written, offset + length);
}

// ---------------------------------------------------------------------------
// Timestamp ZKTeco
// ---------------------------------------------------------------------------

/**
 * ZKTeco menyimpan timestamp log absensi sebagai "packed date", bukan epoch Unix:
 *
 *   t = ((year % 100) * 12 * 31 + month * 31 + (day - 1)) * 86400
 *       + hour * 3600 + minute * 60 + second
 *
 * Kedua referensi implementations memakai rumus ini, dan hasil decode/encode
 * konsisten dua arah, jadi inilah format yang benar-benar dipakai firmware.
 */
function decodeZkTime(value) {
  const raw = value >>> 0;

  const second = raw % 60;
  let t = (raw - second) / 60;
  const minute = t % 60;
  t = (t - minute) / 60;
  const hour = t % 24;
  t = (t - hour) / 24;
  const day = (t % 31) + 1;
  t = (t - (day - 1)) / 31;
  const month = t % 12;
  t = (t - month) / 12;
  const year = t + 2000;

  return { year, month: month + 1, day, hour, minute, second };
}

function encodeZkTime({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return (
    ((year % 100) * 12 * 31 + (month - 1) * 31 + (day - 1)) * 24 * 60 * 60 +
    hour * 60 * 60 +
    minute * 60 +
    second
  );
}

/**
 * Ubah raw timestamp 32-bit menjadi objek Date lokal.
 *
 * Beberapa mesin klon (banyak circulating di pasar lokal) ternyata memakai
 * Unix epoch biasa, bukan packed date. Karena hasil packed-date bisa keluar
 * range yang mustahil, kita cek hasilnya dan fallback ke dua interpretasi lain.
 */
function decodeTimestamp(raw) {
  const value = raw >>> 0;
  const parts = decodeZkTime(value);
  const year = parts.year;

  if (year >= 2000 && year <= 2099 && parts.month >= 1 && parts.month <= 12) {
    return { date: new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second), format: 'packed' };
  }

  // Fallback 1: detik sejak 2000-01-01
  const fromEpoch2000 = new Date(2000, 0, 1, 0, 0, 0, 0);
  fromEpoch2000.setSeconds(fromEpoch2000.getSeconds() + value);
  if (fromEpoch2000.getFullYear() >= 2000 && fromEpoch2000.getFullYear() <= 2099) {
    return { date: fromEpoch2000, format: 'epoch-2000' };
  }

  // Fallback 2: Unix epoch biasa
  return { date: new Date(value * 1000), format: 'unix' };
}

// ---------------------------------------------------------------------------
// Record decoding
// ---------------------------------------------------------------------------

/** Record absensi 40 byte -> objek log. */
function decodeAttendanceRecord(buffer) {
  const rawTime = buffer.readUInt32LE(ATTENDANCE_OFFSET.LOG_TIME);
  const { date, format } = decodeTimestamp(rawTime);
  return {
    userSn: buffer.readUInt16LE(ATTENDANCE_OFFSET.USER_SN),
    deviceUserId: readAscii(buffer.subarray(ATTENDANCE_OFFSET.USER_ID, ATTENDANCE_OFFSET.USER_ID + 9)),
    logTime: date,
    timeFormat: format,
  };
}

/** Record user 72 byte -> objek user. */
function decodeUserRecord(buffer) {
  return {
    uid: buffer.readUInt16LE(USER_OFFSET.UID),
    role: buffer.readUInt8(USER_OFFSET.ROLE),
    password: readAscii(buffer.subarray(USER_OFFSET.PASSWORD, USER_OFFSET.PASSWORD + 8)),
    name: readAscii(buffer.subarray(USER_OFFSET.NAME, USER_OFFSET.NAME + 30)),
    cardNo: buffer.readUInt32LE(USER_OFFSET.CARD),
    deviceUserId: readAscii(buffer.subarray(USER_OFFSET.USER_ID, USER_OFFSET.USER_ID + 9)),
  };
}

/** Record realtime log 52 byte (payload setelah payload header). */
function decodeRealtimeRecord(payload) {
  const deviceUserId = readAscii(payload.subarray(0, 9));
  const timeBytes = payload.subarray(26, 32);
  const { date, format } = decodeTimestamp(timeBytes.readUInt32LE(0));
  return { deviceUserId, logTime: date, timeFormat: format };
}

/**
 * Pisahkan blok data massal menjadi record fixed-size.
 * 4 byte pertama adalah counter yang harus dilewati (lihat referensi).
 */
function splitRecords(buffer, recordSize, decoder) {
  const body = buffer.subarray(4); // lewati counter 4 byte
  const out = [];
  for (let offset = 0; offset + recordSize <= body.length; offset += recordSize) {
    out.push(decoder(body.subarray(offset, offset + recordSize)));
  }
  return out;
}

module.exports = {
  checksum,
  buildFrame,
  decodeFrameHeader,
  isValidMagic,
  isEventFrame,
  commandName,
  readAscii,
  writeAscii,
  decodeZkTime,
  encodeZkTime,
  decodeTimestamp,
  decodeAttendanceRecord,
  decodeUserRecord,
  decodeRealtimeRecord,
  splitRecords,
  RECORD_SIZE,
  FRAME_HEADER_LENGTH,
  PREFIX_LENGTH,
  PAYLOAD_HEADER_LENGTH,
  hex2,
};
