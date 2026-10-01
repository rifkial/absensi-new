'use strict';

const { ZkTcpClient } = require('./client');
const { COMMANDS } = require('./constants');
const db = require('../../db/pool');
const config = require('../../config');
const { toDateTime, toDate } = require('../../utils/date');

/**
 * Adapter untuk mesin yang mendukung protokol ZKTeco Standalone SDK over TCP
 * (port 4370). Ini adalah mode yang didukung hampir semua mesin fingerprint
 * kelas kecil, termasuk banyak mesin merek lokal.
 *
 * Tanggung jawab adapter:
 *   - membuka/menutup koneksi dengan aman
 *   - menarik log & user dari mesin
 *   - menyimpan hasilnya ke tabel attendance_logs (idempoten)
 */
const zktecoAdapter = {
  protocol: 'zkteco-tcp',

  label: 'ZKTeco TCP (port 4370)',

  description:
    'Polling dari server ke mesin memakai protokol biner ZKTeco Standalone SDK. ' +
    'Cocok untuk mesin yang punya menu "Comm / Ethernet" dan bisa diisi IP server.',

  /** Cek konektivitas tanpa menyimpan apa pun. Dipakai tombol "Test" di UI. */
  async test(device) {
    const client = createClient(device);
    try {
      await client.connect();
      const info = await client.getInfo().catch(() => ({}));
      const firmwareVersion = await client.getFirmwareVersion().catch(() => null);
      return {
        ok: true,
        message: `Berhasil terhubung ke ${device.ip_address}:${device.port}`,
        info: { ...info, firmwareVersion, timeFormat: 'packed' },
      };
    } finally {
      await client.disconnect().catch(() => {});
    }
  },

  /**
   * Tarik log absensi dari mesin lalu simpan ke DB.
   * Mengembalikan ringkasan { fetched, inserted, duplicated, unmatched }.
   */
  async sync(device, options = {}) {
    const syncLogId = await startSyncLog(device.id);
    const client = createClient(device);

    try {
      await client.connect();

      const logs = await client.getAttendanceLogs({
        onProgress: (progress) => {
          if (options.onProgress) options.onProgress(progress);
        },
      });

      const users = await client.getUsers().catch(() => []);

      const result = await persistLogs({
        deviceId: device.id,
        logs,
        source: 'sync',
      });

      if (users.length > 0) {
        await upsertDeviceUsers(device.id, users);
      }

      // Opsional: bersihkan log di mesin setelah data aman di server.
      if (config.device.clearLogAfterSync && logs.length > 0) {
        await client.clearAttendanceLogs();
        result.message = `Log mesin dibersihkan (${logs.length} baris tersimpan di server).`;
      }

      await finishSyncLog(syncLogId, { status: 'success', ...result });

      return {
        ok: true,
        fetched: result.fetched,
        inserted: result.inserted,
        duplicated: result.duplicated,
        unmatched: result.unmatched,
        usersOnDevice: users.length,
        message: `${result.inserted} log baru, ${result.duplicated} duplikat diabaikan, ${result.unmatched} PIN tidak terdaftar.`,
      };
    } catch (err) {
      await finishSyncLog(syncLogId, { status: 'failed', message: err.message });
      return { ok: false, message: err.message, error: err };
    } finally {
      await client.disconnect().catch(() => {});
    }
  },

  /** Ambil daftar user dari mesin (untuk mencocokkan dengan master karyawan). */
  async listUsers(device) {
    const client = createClient(device);
    try {
      await client.connect();
      return await client.getUsers();
    } finally {
      await client.disconnect().catch(() => {});
    }
  },

  /**
   * Ambil template sidik jari milik seorang user.
   * Beberapa firmware tidak mendukung pembacaan template lewat
   * 4370, jadi kegagalan di sini tidak dianggap fatal oleh pemanggil.
   */
  async getFingerprints(device, deviceUserId) {
    const client = createClient(device);
    try {
      await client.connect();
      const users = await client.getUsers();
      const user = users.find((u) => String(u.deviceUserId) === String(deviceUserId));
      if (!user) {
        throw new Error(`PIN "${deviceUserId}" tidak ada di mesin ${device.name}.`);
      }
      // Template tidak tersedia lewat jalur ini; kembalikan info enrollment saja.
      return { available: false, reason: 'Pembacaan template lewat TCP tidak didukung firmware ini.', user };
    } finally {
      await client.disconnect().catch(() => {});
    }
  },

  /** Hapus log di mesin (berbahaya - perlu konfirmasi pengguna). */
  async clearLogs(device) {
    const client = createClient(device);
    try {
      await client.connect();
      await client.clearAttendanceLogs();
      return { ok: true, message: 'Seluruh log di mesin sudah dihapus.' };
    } finally {
      await client.disconnect().catch(() => {});
    }
  },
};

function createClient(device) {
  return new ZkTcpClient({
    host: device.ip_address,
    port: device.port || 4370,
    timeout: config.device.timeoutMs,
    password: device.password ? Number(device.password) : 0,
  });
}

async function startSyncLog(deviceId) {
  const result = await db.execute(
    'INSERT INTO sync_logs (device_id, status) VALUES (?, ?)',
    [deviceId, 'running']
  );
  return result.insertId;
}

async function finishSyncLog(syncLogId, { status, message = null, fetched = 0, inserted = 0, duplicated = 0, unmatched = 0 }) {
  await db.execute(
    `UPDATE sync_logs
        SET finished_at = NOW(),
            duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) DIV 1000,
            status = ?, fetched = ?, inserted = ?, duplicated = ?, unmatched = ?, message = ?
      WHERE id = ?`,
    [status, fetched, inserted, duplicated, unmatched, (message || '').slice(0, 500), syncLogId]
  );
}

/**
 * Simpan log dari mesin ke DB dengan deduplikasi.
 *
 * Pencocokan karyawan memakai device_user_id. Log yang device_user_id-nya
 * tidak ada di master karyawan tetap disimpan (device_user_id saja) supaya
 * data tidak hilang, tetapi ditandai "unmatched" agar bisa ditindaklanjuti.
 */
async function persistLogs({ deviceId, logs, source }) {
  let inserted = 0;
  let duplicated = 0;
  let unmatched = 0;

  if (logs.length === 0) {
    return { fetched: 0, inserted: 0, duplicated: 0, unmatched: 0 };
  }

  // Cache PIN -> employee_id supaya tidak query per baris.
  const pins = [...new Set(logs.map((l) => String(l.deviceUserId).trim()).filter(Boolean))];
  const employeeMap = await mapPinsToEmployees(pins);

  const CHUNK = 500;
  for (let i = 0; i < logs.length; i += CHUNK) {
    const slice = logs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(', ');
    const values = [];
    const seen = new Set();

    for (const log of slice) {
      const pin = String(log.deviceUserId ?? '').trim();
      const logTime = toDateTime(log.logTime);
      if (!pin || !logTime) continue;

      // Mesin kadang mengirim log identik beberapa kali dalam satu tarikan;
      // filter di sini agar tidak boros query.
      const dedupeKey = `${pin}|${logTime}`;
      if (seen.has(dedupeKey)) {
        duplicated += 1;
        continue;
      }
      seen.add(dedupeKey);

      const employeeId = employeeMap.get(pin) ?? null;
      if (!employeeId) unmatched += 1;

      values.push(
        deviceId,
        employeeId,
        pin,
        logTime,
        toDate(logTime),
        log.logState ?? 0,
        log.verifyMode ?? 0,
        log.workCode ?? '',
        source
      );
    }

    if (values.length === 0) continue;

    try {
      const result = await db.execute(
        `INSERT IGNORE INTO attendance_logs
           (device_id, employee_id, device_user_id, log_time, log_date, log_state, verify_mode, work_code, source)
         VALUES ${placeholders}`,
        values
      );
      inserted += result.affectedRows;
      duplicated += values.length / 9 - result.affectedRows;
    } catch (err) {
      throw new Error(`Gagal menyimpan log dari mesin: ${err.message}`);
    }
  }

  return { fetched: logs.length, inserted, duplicated, unmatched };
}

/** Ambil peta PIN -> employee_id untuk daftar PIN tertentu. */
async function mapPinsToEmployees(pins) {
  const map = new Map();
  if (pins.length === 0) return map;

  const CHUNK = 500;
  for (let i = 0; i < pins.length; i += CHUNK) {
    const slice = pins.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    const rows = await db.queryAll(
      `SELECT id, device_user_id FROM employees WHERE device_user_id IN (${placeholders})`,
      slice
    );
    for (const row of rows) {
      map.set(String(row.device_user_id).trim(), row.id);
    }
  }
  return map;
}

/** Simpan daftar user dari mesin sebagai informasi perangkat (bukan master karyawan). */
async function upsertDeviceUsers(deviceId, users) {
  const summary = {
    total: users.length,
    sample: users.slice(0, 20).map((u) => ({
      uid: u.uid,
      deviceUserId: u.deviceUserId,
      name: u.name,
      cardNo: u.cardNo,
      role: u.role,
    })),
  };
  await db.execute('UPDATE devices SET last_device_info = ? WHERE id = ?', [
    JSON.stringify(summary),
    deviceId,
  ]);
  return summary;
}

module.exports = {
  adapter: zktecoAdapter,
  persistLogs,
  mapPinsToEmployees,
  COMMANDS,
  toDateTime,
};
