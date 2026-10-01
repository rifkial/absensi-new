'use strict';

const db = require('../db/pool');
const devices = require('../devices');
const { badRequest, notFound, conflict, str, boolParam } = require('../utils/errors');

const SELECT = `
  id, name, protocol, ip_address, port, location, serial_number,
  is_active, auto_sync, sync_interval_min,
  last_sync_at, last_sync_status, last_sync_message, last_device_info,
  created_at, updated_at
`;

function mapRow(row) {
  if (!row) return null;
  let deviceInfo = null;
  if (row.last_device_info) {
    try {
      deviceInfo = JSON.parse(row.last_device_info);
    } catch {
      deviceInfo = { raw: row.last_device_info };
    }
  }
  return { ...row, is_active: Boolean(row.is_active), auto_sync: Boolean(row.auto_sync), last_device_info: deviceInfo };
}

async function list({ activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1 AND auto_sync = 1' : '';
  const rows = await db.queryAll(`SELECT ${SELECT} FROM devices ${where} ORDER BY name ASC`);
  return rows.map(mapRow);
}

async function getById(id) {
  const row = await db.queryOne(`SELECT ${SELECT} FROM devices WHERE id = ?`, [id]);
  return mapRow(row);
}

async function getOrFail(id) {
  const device = await getById(id);
  if (!device) throw notFound(`Perangkat dengan id ${id} tidak ditemukan.`);
  return device;
}

async function getBySerial(serial) {
  const row = await db.queryOne(`SELECT ${SELECT} FROM devices WHERE serial_number = ?`, [String(serial).trim()]);
  return mapRow(row);
}

/** Validasi input perangkat. Aturan berbeda per protokol. */
function normalize(payload, { partial = false } = {}) {
  const data = {};

  if (!partial || payload.name !== undefined) {
    const name = str(payload.name, { maxLength: 100 });
    if (!name) throw badRequest('name (nama perangkat) wajib diisi.');
    data.name = name;
  }

  if (!partial || payload.protocol !== undefined) {
    const protocol = str(payload.protocol, { maxLength: 30 });
    if (!protocol) throw badRequest('protocol wajib diisi.');
    if (!devices.hasAdapter(protocol)) {
      throw badRequest(
        `protocol "${protocol}" tidak dikenali. Pilihan: ${devices.listProtocols().map((p) => p.protocol).join(', ')}.`
      );
    }
    data.protocol = protocol;
  }

  if (payload.ip_address !== undefined) {
    const ip = str(payload.ip_address, { maxLength: 45 });
    if (ip && !isValidHost(ip)) throw badRequest(`ip_address "${ip}" tidak valid.`);
    data.ip_address = ip || null;
  }

  if (payload.port !== undefined) {
    const port = Number(payload.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw badRequest('port harus angka bulat 1-65535.');
    }
    data.port = port;
  }

  if (payload.location !== undefined) data.location = str(payload.location, { maxLength: 150 }) || null;
  if (payload.serial_number !== undefined) data.serial_number = str(payload.serial_number, { maxLength: 60 }) || null;

  if (payload.is_active !== undefined) {
    const value = boolParam(payload.is_active);
    if (value === null) throw badRequest('is_active harus boolean.');
    data.is_active = value ? 1 : 0;
  }

  if (payload.auto_sync !== undefined) {
    const value = boolParam(payload.auto_sync);
    if (value === null) throw badRequest('auto_sync harus boolean.');
    data.auto_sync = value ? 1 : 0;
  }

  if (payload.sync_interval_min !== undefined) {
    const value = Number(payload.sync_interval_min);
    if (!Number.isInteger(value) || value < 1 || value > 1440) {
      throw badRequest('sync_interval_min harus angka bulat 1-1440 (menit).');
    }
    data.sync_interval_min = value;
  }

  return data;
}

/** Host bisa berupa IP, hostname, atau IPv6. */
function isValidHost(value) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  if (value.includes(':')) return true; // IPv6
  return /^[A-Za-z0-9]([A-Za-z0-9-_.]{0,253}[A-Za-z0-9])?$/.test(value);
}

async function create(payload) {
  const data = normalize(payload);
  const adapter = devices.getAdapter(data.protocol);

  if (adapter.protocol === 'zkteco-tcp' && !data.ip_address) {
    throw badRequest('ip_address wajib diisi untuk protokol zkteco-tcp.');
  }
  if (!data.port) {
    data.port = data.protocol === 'zkteco-tcp' ? 4370 : data.protocol === 'push-http' ? 3001 : 0;
  }
  data.is_active = data.is_active ?? 1;
  data.auto_sync = data.auto_sync ?? 1;
  data.sync_interval_min = data.sync_interval_min ?? 5;
  data.last_sync_status = 'idle';

  const columns = Object.keys(data);
  const result = await db.execute(
    `INSERT INTO devices (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => data[c])
  );

  return getById(result.insertId);
}

async function update(id, payload) {
  const current = await getOrFail(id);
  const data = normalize(payload, { partial: true });

  if (Object.keys(data).length === 0) throw badRequest('Tidak ada field yang diubah.');

  if (data.name) {
    const existing = await db.queryOne('SELECT id FROM devices WHERE name = ?', [data.name]);
    if (existing && existing.id !== Number(id)) throw conflict(`Nama perangkat "${data.name}" sudah dipakai.`);
  }

  const nextProtocol = data.protocol || current.protocol;
  if (nextProtocol === 'zkteco-tcp') {
    const ip = data.ip_address !== undefined ? data.ip_address : current.ip_address;
    if (!ip) throw badRequest('ip_address wajib diisi untuk protokol zkteco-tcp.');
  }

  const columns = Object.keys(data);
  await db.execute(
    `UPDATE devices SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => data[c]), id]
  );

  return getById(id);
}

async function remove(id) {
  const device = await getOrFail(id);
  const logCount = await db.queryScalar('SELECT COUNT(*) FROM attendance_logs WHERE device_id = ?', [id]);

  if (Number(logCount) > 0) {
    // Jangan hapus perangkat yang sudah punya log; nonaktifkan saja.
    await db.execute('UPDATE devices SET is_active = 0, auto_sync = 0 WHERE id = ?', [id]);
    return {
      deleted: false,
      archived: true,
      device,
      message: `Perangkat memiliki ${logCount} log sehingga tidak dihapus, 대신 dinonaktifkan.`,
    };
  }

  await db.execute('DELETE FROM devices WHERE id = ?', [id]);
  return { deleted: true, archived: false, device, message: 'Perangkat dihapus.' };
}

/** Uji konektivitas ke mesin tanpa menyimpan data. */
async function test(id) {
  const device = await getOrFail(id);
  const adapter = devices.getAdapter(device.protocol);

  const startedAt = Date.now();
  try {
    const result = await adapter.test(device);
    const durationMs = Date.now() - startedAt;

    await db.execute(
      `UPDATE devices
          SET last_sync_at = NOW(), last_sync_status = ?, last_sync_message = ?, last_device_info = ?
        WHERE id = ?`,
      [
        result.ok ? 'success' : 'failed',
        (result.message || '').slice(0, 500),
        result.info ? JSON.stringify(result.info).slice(0, 60000) : null,
        id,
      ]
    );

    return { ...result, duration_ms: durationMs };
  } catch (err) {
    await db.execute(
      'UPDATE devices SET last_sync_at = NOW(), last_sync_status = ?, last_sync_message = ? WHERE id = ?',
      ['failed', err.message.slice(0, 500), id]
    );
    return { ok: false, message: err.message, duration_ms: Date.now() - startedAt };
  }
}

/** Jalankan sinkronisasi satu perangkat. */
async function syncOne(id) {
  const device = await getOrFail(id);
  const adapter = devices.getAdapter(device.protocol);

  await db.execute("UPDATE devices SET last_sync_status = 'running' WHERE id = ?", [id]);

  const result = await adapter.sync(device);

  await db.execute(
    `UPDATE devices
        SET last_sync_at = NOW(),
            last_sync_status = ?,
            last_sync_message = ?,
            last_device_info = COALESCE(?, last_device_info)
      WHERE id = ?`,
    [result.ok ? 'success' : 'failed', (result.message || '').slice(0, 500), null, id]
  );

  return { device: device.name, ...result };
}

/** Riwayat sinkronisasi terakhir. */
async function syncHistory({ deviceId = null, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (deviceId) {
    where = 'WHERE s.device_id = ?';
    params.push(Number(deviceId));
  }
  const max = Math.min(500, Math.max(1, Number(limit) || 50));

  return db.queryAll(
    `SELECT s.*, d.name AS device_name, d.protocol
       FROM sync_logs s
       LEFT JOIN devices d ON d.id = s.device_id
     ${where}
      ORDER BY s.started_at DESC
      LIMIT ${max}`,
    params
  );
}

/** Daftar protokol yang didukung, untuk form perangkat. */
function protocolOptions() {
  return devices.listProtocols();
}

module.exports = {
  list,
  getById,
  getOrFail,
  getBySerial,
  create,
  update,
  remove,
  test,
  syncOne,
  syncHistory,
  protocolOptions,
  normalize,
};
