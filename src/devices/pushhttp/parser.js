'use strict';

const { toDateTime, toDate, normalizeMachineTime } = require('../../utils/date');

/**
 * Parser untuk protokol ZKTeco PUSH (ADMS / icLock).
 *
 * Yang dipakai di sini adalah "Attendance PUSH Communication Protocol" resmi
 * (PUSH SDK 2.4.1, doc 3.7) yang berbasis HTTP/1.1, bukan line protocol
 * kuno port 4371. Ringkasnya:
 *
 *   GET  /iclock/cdata?SN=..&options=all&language=..&pushver=..
 *        -> device handshake, server balas body konfigurasi
 *   POST /iclock/cdata?SN=..&table=ATTLOG&Stamp=..
 *        -> body: <PIN>\t<Time>\t<Status>\t<Verify>\t<Workcode>\t<Res>\t<Res>\n
 *        -> server balas "OK: <jumlah>"
 *   POST /iclock/fdata?SN=..&table=FINGERTMP|BIODATA|ATTPHOTO&Stamp=..
 *   POST /iclock/devicecmd?SN=..     -> hasil balasan perintah
 *   GET  /iclock/getrequest?SN=..    -> long-poll; server balas "OK" atau 1 perintah
 */

const TABLES = {
  ATTLOG: 'ATTLOG',
  FINGERTMP: 'FINGERTMP',
  BIODATA: 'BIODATA',
  ATTPHOTO: 'ATTPHOTO',
  USERINFO: 'USERINFO',
  REGOPT: 'REGOPT',
  ATTDATA: 'ATTDATA',
};

/** Bahasa mesin (Appendix 2 spesifikasi) - dipakai balasan handshake. */
const LANGUAGE = 73; // Bahasa Indonesia

/** Versi PUSH yang didukung server ini. */
const PUSH_VER = '2.4.1';

/**
 * Parse body ATTLOG: satu record per baris, 7 field dipisah TAB.
 * Contoh: "1452\t2015-07-30 15:16:28\t0\t1\t0\t0\t0"
 */
function parseAttlogBody(body) {
  const records = [];
  const lines = String(body || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const fields = line.split('\t');
    if (fields.length < 2) continue;

    const pin = String(fields[0] || '').trim();
    const time = normalizeMachineTime(fields[1]);
    if (pin === '' || !time) continue;

    const logTime = toDateTime(time);
    if (!logTime) continue;

    records.push({
      deviceUserId: pin,
      logTime,
      logDate: toDate(logTime),
      logState: toInt(fields[2], 0),
      verifyMode: toInt(fields[3], 0),
      workCode: String(fields[4] ?? '').trim(),
      // fields[5] dan fields[6] adalah reserved, tidak dipakai
    });
  }

  return records;
}

/**
 * Parse body FINGERTMP / BIODATA.
 * Contoh FINGERTMP: "FP\tPIN=1\tFID=0\tSize=392\tValid=1\tTMP=<base64>"
 * Contoh BIODATA:  "BIODATA Pin=1\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=1\t..."
 */
function parseBiometricBody(body) {
  const records = [];
  const lines = String(body || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const tabIndex = trimmed.indexOf('\t');
    const head = tabIndex >= 0 ? trimmed.slice(0, tabIndex) : trimmed;
    const tail = tabIndex >= 0 ? trimmed.slice(tabIndex + 1) : '';

    const fields = parseKeyValueFields(tail, tabIndex >= 0 ? '\t' : ' ');
    if (Object.keys(fields).length === 0) continue;

    const templateB64 = fields.TMP || fields.Tmp || '';
    const size = templateB64 ? Buffer.from(templateB64, 'base64').length : toInt(fields.Size, 0);

    records.push({
      kind: head.toUpperCase(),
      deviceUserId: String(fields.PIN ?? fields.Pin ?? '').trim(),
      fingerIndex: toInt(fields.FID ?? fields.No ?? fields.Index, 0),
      valid: toInt(fields.Valid, 0),
      duress: toInt(fields.Duress, 0),
      type: toInt(fields.Type, 1),
      size,
      template: templateB64 ? Buffer.from(templateB64, 'base64') : null,
    });
  }

  return records;
}

/** Parse "PIN=1&Name=John" atau "PIN=1\tName=John" jadi objek. */
function parseKeyValueFields(input, separator = '&') {
  const out = {};
  if (!input) return out;

  String(input)
    .split(separator)
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (key) out[key] = value;
    });

  return out;
}

/**
 * Parse balasan perintah dari mesin (dikirim via POST /iclock/devicecmd).
 * Bentuk umum: "ID=1&Return=0&CMD=DATA"
 * Bentuk berformat, dipisah baris: "ID=1&Return=0&CMD=INFO\nKey=Value\n..."
 */
function parseCommandReply(body) {
  const text = String(body || '').replace(/\0/g, '').trim();
  if (text === '') return { ok: false, raw: text };

  const firstLine = text.split(/\r?\n/)[0];
  const fields = parseKeyValueFields(firstLine, '&');

  const result = {
    raw: text,
    id: fields.ID ?? null,
    returnCode: fields.Return !== undefined ? toInt(fields.Return, -999) : null,
    cmd: fields.CMD ?? null,
    startTime: fields.StartTime ?? null,
    endTime: fields.EndTime ?? null,
    lines: text.split(/\r?\n/).slice(1).filter((l) => l.trim() !== ''),
    records: [],
  };

  result.ok = result.returnCode === 0;
  result.message = describeReturnCode(result.returnCode);

  // Ekstrak record data dari baris lanjutan (dipakai saat menarik ATTLOG/USERINFO).
  const tail = result.lines.join('\n');
  if (result.cmd && /DATA/i.test(result.cmd)) {
    const table = (firstLine.match(/CMD=DATA\s+(\w+)/i) || [])[1];
    if (table === TABLES.ATTLOG) {
      result.records = parseAttlogBody(tail);
    } else if (table === TABLES.FINGERTMP || table === TABLES.BIODATA) {
      result.records = parseBiometricBody(tail);
    } else if (table === TABLES.USERINFO) {
      result.records = parseUserInfoBody(tail);
    }
  }

  return result;
}

/** Parse baris USERINFO yang dikirim mesin. */
function parseUserInfoBody(body) {
  const users = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const fields = parseKeyValueFields(line, /\s|&/);
    if (!fields.PIN && !fields.Pin) continue;
    users.push({
      deviceUserId: String(fields.PIN ?? fields.Pin ?? '').trim(),
      name: fields.Name ?? '',
      privilege: toInt(fields.Pri, 0),
      password: fields.Pass ?? '',
      cardNo: fields.Card ?? '',
      groupId: toInt(fields.Grp, 1),
      timeZone: fields.TZ ?? '',
    });
  }
  return users;
}

/**
 * Bangun body konfigurasi untuk balasan handshake /iclock/cdata.
 * Field minimal yang wajib ada agar mesin tetap mengirim log.
 */
function buildConfigResponse(device = {}) {
  return [
    'GET OPTION FROM:ATTLOG',
    'Stamp=' + (device.lastStamp ?? '9999'),
    'OpStamp=0',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData Up|Photo Down',
    'TimeZone=3',
    'Realtime=1',
    'Encrypt=0',
    'ServerVer=2.4.1',
    'PushProtVer=2.4.1',
    'PushVer=2.4.1',
    'Language=' + LANGUAGE,
    'MultiBioDataSupport=1',
    'MultiBioPhotoSupport=1',
    'MultiBioVersion=10',
    'MaxMultiBioDataCount=10',
    'MaxMultiBioPhotoCount=7',
    'PhotoSize=0',
    'RS485_Both=1',
    'RS485_Serial=0',
    'Serial=38400',
    'TCPServer=' + (device.serverAddress ?? ''),
    'TCPPort=' + (device.serverPort ?? ''),
    '',
  ].join('\r\n');
}

/** Balasan minimal untuk long-poll /iclock/getrequest saat antrean kosong. */
const EMPTY_POLL_RESPONSE = 'OK';

function describeReturnCode(code) {
  if (code === null || code === undefined) return 'Mesin tidak mengirim kode balasan.';
  if (code === 0) return 'Berhasil.';

  const table = {
    '-1': 'Parameter salah.',
    '-2': 'Ukuran data foto tidak sesuai.',
    '-3': 'Proses baca/tulis gagal.',
    '-9': 'Ukuran template tidak sesuai.',
    '-10': 'PIN tidak ditemukan di mesin.',
    '-11': 'Format sidik jari tidak valid.',
    '-12': 'Data sidik jari tidak valid.',
    '-1001': 'Kapasitas mesin penuh.',
    '-1002': 'Tidak didukung oleh mesin.',
    '-1003': 'Perintah timeout.',
    '-1004': 'Data/konfigurasi tidak konsisten.',
    '-1005': 'Mesin sedang sibuk.',
    '-1006': 'Data terlalu panjang.',
    '-1007': 'Kesalahan memori.',
    '-1008': 'Gagal mengambil data dari server.',
    '1': 'Sukses sebagian.',
  };

  return table[String(code)] || `Kode balik tidak dikenal: ${code}`;
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  TABLES,
  LANGUAGE,
  PUSH_VER,
  parseAttlogBody,
  parseBiometricBody,
  parseUserInfoBody,
  parseCommandReply,
  parseKeyValueFields,
  buildConfigResponse,
  describeReturnCode,
  EMPTY_POLL_RESPONSE,
};
