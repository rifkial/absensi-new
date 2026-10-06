'use strict';

const db = require('../db/pool');
const devicesService = require('./devices');
const attendanceService = require('./attendance');
const holidaysService = require('./holidays');
const notify = require('./notify');
const config = require('../config');
const { addDays, today } = require('../utils/date');

/**
 * Orkestrator sinkronisasi.
 *
 * Untuk setiap perangkat aktif dengan auto_sync:
 *   1. panggil adapter untuk menarik data dari mesin
 *   2. rekap absensi untuk hari-hari yang terpengaruh
 *   3. kirim notifikasi bila ada kegagalan
 *
 * startScheduler() di file ini juga dipanggil saat server menyala
 * (lihat src/server.js), jadi penjadwal ikut hidup bersama proses Node.
 */

/** Lock supaya dua siklus tidak tumpang tindih. */
let running = false;
let timer = null;
let cycleCount = 0;
let lastCycle = null;

async function getSyncableDevices() {
  return db.queryAll(
    `SELECT id, name, protocol, ip_address, port, auto_sync, sync_interval_min, last_sync_at
       FROM devices
      WHERE is_active = 1 AND auto_sync = 1
      ORDER BY name ASC`
  );
}

/**
 * Apakah perangkat sudah waktunya disinkronkan lagi?
 * Memakai sync_interval_min per perangkat, dengan batas bawah config global.
 */
function isDue(device, minIntervalMinutes) {
  const interval = Math.max(minIntervalMinutes, Number(device.sync_interval_min) || minIntervalMinutes);
  if (!device.last_sync_at) return true;
  const last = new Date(String(device.last_sync_at).replace(' ', 'T'));
  if (Number.isNaN(last.getTime())) return true;
  return Date.now() - last.getTime() >= interval * 60 * 1000;
}

/**
 * Jalankan satu siklus sinkronisasi penuh.
 * `options.only` = id perangkat tertentu (untuk tombol "Sinkron sekarang").
 */
async function runCycle({ only = null, force = false, minIntervalMinutes = null, regenerateDays = 1 } = {}) {
  if (running) {
    return { ok: false, message: 'Siklus sinkronisasi masih berjalan.', skipped: true };
  }

  running = true;
  cycleCount += 1;
  const startedAt = Date.now();
  const interval = minIntervalMinutes ?? config.device.syncIntervalMinutes;

  const summary = {
    cycle: cycleCount,
    started_at: new Date().toISOString(),
    devices: [],
    inserted: 0,
    duplicated: 0,
    unmatched: 0,
    failed: 0,
    regenerated: null,
  };

  try {
    let all = await getSyncableDevices();
    if (only) all = all.filter((d) => Number(d.id) === Number(only));
    else if (!force) all = all.filter((d) => isDue(d, interval));

    for (const device of all) {
      const deviceResult = await syncDeviceSafely(device);
      summary.devices.push(deviceResult);
      summary.inserted += Number(deviceResult.inserted || 0);
      summary.duplicated += Number(deviceResult.duplicated || 0);
      summary.unmatched += Number(deviceResult.unmatched || 0);
      if (!deviceResult.ok) summary.failed += 1;
    }

    // Rekap ulang setelah semua data masuk, supaya cukup satu kali tulis.
    if (summary.inserted > 0 || only || force) {
      const days = Math.max(1, Math.min(60, Number(regenerateDays) || 1));
      const from = addDays(today(), -(days - 1));
      summary.regenerated = await attendanceService.generate({ from, to: today() });
    }

    // Hari libur nasional dari API (hanya jalan bila sudah jatuh tempo).
    const holidayResult = await holidaysService.autoSyncIfDue().catch((err) => {
      console.error('[sync] Sinkron hari libur gagal:', err.message);
      return null;
    });
    if (holidayResult) {
      summary.holidays = {
        years: holidayResult.years,
        message: holidayResult.message,
      };
    }

    // Notifikasi kegagalan sinkronisasi (dibatasi agar tidak spam).
    if (summary.failed > 0) {
      await notify.notifySyncFailed(summary).catch((err) => {
        console.error('[sync] Gagal mengirim notifikasi:', err.message);
      });
    }
  } catch (err) {
    summary.error = err.message;
    console.error('[sync] Siklus gagal:', err.message);
  } finally {
    running = false;
  }

  summary.duration_ms = Date.now() - startedAt;
  summary.finished_at = new Date().toISOString();
  lastCycle = summary;

  // Jangan berisik bila tidak ada kerjaan (0 perangkat jatuh tempo):
  // log tiap 5 menit mengganggu terminal tanpa info baru.
  const idle = summary.devices.length === 0 && summary.inserted === 0 && summary.failed === 0 && !summary.holidays;
  if (!idle) {
    const okCount = summary.devices.filter((d) => d.ok).length;
    console.log(
      `[sync] Siklus #${summary.cycle} selesai dalam ${summary.duration_ms}ms - ` +
        `${okCount}/${summary.devices.length} perangkat OK, ${summary.inserted} log baru, ${summary.failed} gagal.`
    );
  }

  return summary;
}

/** Sinkronisasi satu perangkat dengan penanganan error yang tidak melempar. */
async function syncDeviceSafely(device) {
  try {
    const result = await devicesService.syncOne(device.id);
    return { id: device.id, name: device.name, protocol: device.protocol, ...result };
  } catch (err) {
    await db.execute(
      "UPDATE devices SET last_sync_at = NOW(), last_sync_status = 'failed', last_sync_message = ? WHERE id = ?",
      [err.message.slice(0, 500), device.id]
    );
    return {
      id: device.id,
      name: device.name,
      protocol: device.protocol,
      ok: false,
      message: err.message,
      inserted: 0,
      duplicated: 0,
      unmatched: 0,
    };
  }
}

/** Sinkron manual satu perangkat (dipakai tombol di UI). */
async function syncDeviceById(id, options = {}) {
  return runCycle({ only: id, force: true, ...options });
}

/** Sinkron semua perangkat yang ada (dipakai tombol "Sinkron Semua"). */
async function syncAll(options = {}) {
  return runCycle({ force: true, ...options });
}

/** Nyalakan penjadwal otomatis. */
let kickoff = null;
function startScheduler({ intervalMinutes = config.device.syncIntervalMinutes } = {}) {
  if (timer) return timer;

  // Kickoff ditunda 30 detik supaya load awal / refresh pertama tidak
  // berebut pool DB dengan siklus sync. Siklus sendiri hanya jalan bila
  // ada perangkat jatuh tempo; tanpa perangkat = idle, tanpa rekap.
  kickoff = setTimeout(() => {
    kickoff = null;
    runCycle({ minIntervalMinutes: intervalMinutes }).catch((err) => {
      console.error('[scheduler] Error:', err.message);
    });
  }, 30000);

  timer = setInterval(() => {
    runCycle({ minIntervalMinutes: intervalMinutes }).catch((err) => {
      console.error('[scheduler] Error:', err.message);
    });
  }, Math.max(1, intervalMinutes) * 60 * 1000);

  timer.unref?.();
  kickoff.unref?.();

  console.log(
    `[scheduler] Penjadwal aktif: Sinkron tiap ${intervalMinutes} menit bila ada perangkat jatuh tempo, rekap 1 hari.`
  );

  return timer;
}

function stopScheduler() {
  if (kickoff) {
    clearTimeout(kickoff);
    kickoff = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[scheduler] Penjadwal dihentikan.');
  }
}

function status() {
  return {
    enabled: timer !== null,
    running,
    cycle_count: cycleCount,
    interval_minutes: config.device.syncIntervalMinutes,
    last_cycle: lastCycle,
  };
}

module.exports = {
  runCycle,
  syncDeviceById,
  syncAll,
  startScheduler,
  stopScheduler,
  status,
  getSyncableDevices,
  isDue,
};
