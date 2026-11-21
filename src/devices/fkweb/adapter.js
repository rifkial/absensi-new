'use strict';

const db = require('../../db/pool');
const config = require('../../config');
const { persistLogs } = require('../zkteco4370/adapter');
const { getLocalAddressHint } = require('../pushhttp/adapter');
const {
  parseFkTime,
  parseFkTimeToMillis,
  parseLogRecords,
  parseUserEntries,
  mapVerifyCode,
} = require('./codec');
const { CommandQueue } = require('./queue');
const { COMMANDS, setTimeParam } = require('./commands');

const queue = new CommandQueue();

/** dev_id (Cloud ID) -> { deviceId, lastSeenAt, ip, firmware, fkInfo, timeFixAt } */
const liveDevices = new Map();

/**
 * Catat mesin yang sedang menghubungi server FkWeb.
 * Perangkat baru otomatis dibuat di tabel devices dengan serial_number = dev_id.
 */
async function registerDevice(devId, req, fkInfo = null) {
  let live = liveDevices.get(devId);

  if (!live) {
    live = {
      deviceId: null,
      lastSeenAt: new Date(),
      ip: req.ip || req.socket?.remoteAddress || null,
      firmware: null,
      fkInfo: null,
      timeFixAt: 0,
    };
    liveDevices.set(devId, live);
  }

  live.lastSeenAt = new Date();
  live.ip = req.ip || req.socket?.remoteAddress || null;
  if (fkInfo) {
    live.fkInfo = fkInfo;
    live.firmware = fkInfo.fk_info?.firmware || live.firmware;
  }

  if (!live.deviceId) {
    live.deviceId = await getOrCreateDeviceId(devId, live);
  }

  return live;
}

async function getOrCreateDeviceId(devId, live = {}) {
  const existing = await db.queryOne('SELECT id FROM devices WHERE serial_number = ?', [devId]);
  if (existing) return existing.id;

  const name = `Mesin FkWeb ${devId}`.slice(0, 100);
  const message = live.firmware ? `Firmware: ${live.firmware}` : 'Terhubung ke server FkWeb.';

  try {
    const result = await db.execute(
      `INSERT INTO devices (name, protocol, ip_address, port, serial_number, location, last_sync_status, last_sync_message)
       VALUES (?, 'fkweb-http', ?, ?, ?, 'Terdaftar otomatis via FkWeb', 'success', ?)`,
      [name, live.ip || null, config.server.fkwebPort, devId, message.slice(0, 500)]
    );
    console.log(`[fkweb] Perangkat baru terdaftar: ${name}`);
    return result.insertId;
  } catch (err) {
    // Balapan dua request pertama: ambil baris yang sudah dibuat request lain.
    if (err.code === 'ER_DUP_ENTRY') {
      const row = await db.queryOne('SELECT id FROM devices WHERE serial_number = ?', [devId]);
      if (row) return row.id;
    }
    throw err;
  }
}

/** Ubah realtime_glog menjadi record yang diterima persistLogs. */
function mapRealtimeLog(data) {
  const logTime = parseFkTime(data.io_time);
  if (!logTime) return null;

  const pin = String(data.user_id ?? '').trim();
  if (!pin) return null;

  return {
    deviceUserId: pin,
    logTime,
    logDate: logTime.slice(0, 10),
    logState: (Number(data.io_mode) >>> 24) === 2 ? 1 : 0,
    verifyMode: mapVerifyCode(Number(data.verify_mode)),
    workCode: '',
  };
}

/** Perbaiki jam mesin bila `fk_time` meleset jauh (mis. setelah listrik mati). */
function maybeFixTime(devId, live, fkTime) {
  if (!fkTime) return;
  if (Date.now() - Number(live.timeFixAt || 0) < 5 * 60 * 1000) return;

  const deviceMs = parseFkTimeToMillis(fkTime);
  if (deviceMs === null || Math.abs(Date.now() - deviceMs) <= 5 * 60 * 1000) return;

  live.timeFixAt = Date.now();
  queue.enqueue(devId, COMMANDS.SET_TIME, setTimeParam(), 60000).catch(() => {
    // Mesin mungkin sibuk; percobaan berikutnya ditunda 5 menit.
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const fkwebAdapter = {
  protocol: 'fkweb-http',
  label: 'Fingerspot FkWeb (Internet)',
  description:
    'Mesin Fingerspot Revo mode Internet mengirim absensi ke server ini (FkWeb HTTP). ' +
    `Di mesin: Jaringan -> Mode Internet, Server IP = ${getLocalAddressHint()}, Server Port = ${config.server.fkwebPort}, ` +
    'Server Req = Ya. Tanpa autentikasi; batasi akses lewat firewall/LAN.',

  /** Tidak ada koneksi server -> mesin; status dilihat dari request terakhir. */
  async test(device) {
    const devId = device.serial_number;
    if (!devId) {
      return {
        ok: false,
        message: 'Serial Number / Cloud ID belum diisi. Isi dengan Cloud ID mesin atau biarkan terisi otomatis saat mesin terhubung.',
      };
    }

    const live = liveDevices.get(devId);
    if (live && Date.now() - live.lastSeenAt.getTime() < 2 * 60 * 1000) {
      return {
        ok: true,
        message: `Mesin ${devId} aktif terhubung (IP ${live.ip || '-'}).`,
        info: {
          firmwareVersion: live.firmware || null,
          lastSeenAt: live.lastSeenAt.toISOString(),
          fkInfo: live.fkInfo,
        },
      };
    }

    return {
      ok: false,
      message:
        `Mesin ${devId} belum terhubung ke server FkWeb. Di mesin: Jaringan -> Mode Internet, ` +
        `Server IP = ${getLocalAddressHint()}, Server Port = ${config.server.fkwebPort}, Server Req = Ya.`,
    };
  },

  /** Tarik seluruh log lewat perintah GET_LOG_DATA. */
  async sync(device) {
    const devId = device.serial_number;
    if (!devId) {
      return { ok: false, message: 'Serial Number / Cloud ID mesin belum diisi.' };
    }

    const live = liveDevices.get(devId);
    if (!live || Date.now() - live.lastSeenAt.getTime() > 2 * 60 * 1000) {
      return { ok: false, message: 'Mesin belum terhubung ke server FkWeb; perintah tidak bisa dikirim.' };
    }

    try {
      const result = await queue.enqueue(devId, COMMANDS.GET_LOG_DATA, Buffer.alloc(0), 120000);
      if (result.returnCode && result.returnCode !== 'OK') {
        throw new Error(`Mesin menolak GET_LOG_DATA: ${result.returnCode}`);
      }

      const recordSize = Number(result.json?.one_log_size) || 48;
      const logs = parseLogRecords(result.bins?.[0], recordSize);
      const saved = await persistLogs({ deviceId: device.id, logs, source: 'push' });

      return {
        ok: true,
        fetched: saved.fetched,
        inserted: saved.inserted,
        duplicated: saved.duplicated,
        unmatched: saved.unmatched,
        message: `${saved.inserted} log baru, ${saved.duplicated} duplikat, ${saved.unmatched} PIN tidak terdaftar.`,
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  /** Daftar PIN user di mesin (nama tidak tersedia di GET_USER_ID_LIST). */
  async listUsers(device) {
    const devId = device.serial_number;
    if (!devId) throw new Error('Serial Number / Cloud ID mesin belum diisi.');

    const live = liveDevices.get(devId);
    if (!live || Date.now() - live.lastSeenAt.getTime() > 2 * 60 * 1000) {
      throw new Error('Mesin belum terhubung ke server FkWeb; perintah tidak bisa dikirim.');
    }

    const result = await queue.enqueue(devId, COMMANDS.GET_USER_ID_LIST, Buffer.alloc(0), 120000);
    if (result.returnCode && result.returnCode !== 'OK') {
      throw new Error(`Mesin menolak GET_USER_ID_LIST: ${result.returnCode}`);
    }

    const recordSize = Number(result.json?.one_user_id_size) || 36;
    const users = parseUserEntries(result.bins?.[0], recordSize);

    return users.map((u) => ({
      uid: null,
      deviceUserId: u.deviceUserId,
      name: null,
      cardNo: null,
      role: u.manager ? 'manager' : 'user',
      active: u.active,
      enrolled: u.enrolled,
    }));
  },

  queue,
  liveDevices,
};

module.exports = {
  fkwebAdapter,
  registerDevice,
  getOrCreateDeviceId,
  mapRealtimeLog,
  maybeFixTime,
  queue,
  liveDevices,
  getLocalAddressHint,
};