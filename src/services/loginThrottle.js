'use strict';

/**
 * Pembatas percobaan login (rate limit + lockout sementara).
 *
 * Tujuannya menahan brute force password tanpa mengganggu orang yang salah ketik
 * sekali atau dua kali. Dua lapis proteksi:
 *
 *   1. Pelonggaran (throttle) per pasangan IP + username. Setelah beberapa
 *      kali gagal, permintaan berikutnya harus menunggu (429).
 *   2. Kunci akun sementara bila satu username gagal terus-menerus dari
 *      berbagai IP, sehingga serangan dari IP berbeda tidak bisa saling
 *      membantu.
 *
 * State disimpan di memori proses. Untuk instalasi单机 (satu server) ini cukup
 * dan tidak menambah dependensi. Bila nanti dijalankan di banyak instance,
 * ganti sumber datanya ke Redis.
 *
 * Catatan penting: penghitung hanya bertambah pada login GAGAL. Berhasil login
 * menghapus riwayat, supaya admin yang salah ketik tidak terkunci selamanya.
 */

const DEFAULTS = {
  // Master saklar.
  enabled: true,
  // Toleransi salah ketik sebelum pelonggaran mulai berlaku.
  freeAttempts: 5,
  // Jeda antar percobaan setelah ambang terlampaui (detik, bertambah linear).
  baseDelaySeconds: 3,
  maxDelaySeconds: 300,
  // Lama akun dikunci setelah terlalu banyak gagal dari satu username.
  lockThreshold: 10,
  lockSeconds: 900, // 15 menit
  // Sisa TTL counters, supaya Map tidak tumbuh tanpa batas.
  entryTtlMs: 60 * 60 * 1000,
  // Potongan Settings (bisa diubah dari tabel settings).
  settingKeys: {
    enabled: 'login_rate_limit_enabled',
    freeAttempts: 'login_free_attempts',
    lockThreshold: 'login_lock_threshold',
    lockSeconds: 'login_lock_seconds',
  },
};

const policy = { ...DEFAULTS };

/** Kunci unik untuk satu username (tanpa regard case). */
function usernameKey(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * State rate limit.
 * attemptsByIpUser : Map "ip|username" -> { fails, firstFailAt, lastFailAt }
 * attemptsByUser   : Map username     -> { fails, lockedUntil, lastFailAt }
 * ipFails          : Map ip           -> { fails, lastFailAt }
 */
const attemptsByIpUser = new Map();
const attemptsByUser = new Map();
const ipFails = new Map();

function prune(now) {
  for (const [key, entry] of attemptsByIpUser) {
    if (now - entry.lastFailAt > policy.entryTtlMs) attemptsByIpUser.delete(key);
  }
  for (const [key, entry] of ipFails) {
    if (now - entry.lastFailAt > policy.entryTtlMs) ipFails.delete(key);
  }
  // Kunci akun yang sudah lewat tidak perlu dihapus, tapi dicek saat dipakai.
  for (const [key, entry] of attemptsByUser) {
    if (entry.fails === 0 && now - entry.lastFailAt > policy.entryTtlMs) attemptsByUser.delete(key);
  }
}

/** Kunci gabungan IP + username. */
function pairKey(ip, username) {
  return `${ip}|${usernameKey(username)}`;
}

/**
 * Periksa apakah percobaan login saat ini boleh diteruskan.
 *
 * @param {string} ip
 * @param {string} username
 * @returns {{allowed:boolean, retryAfter:number, lockedUntil:number|null,
 *   reason:string|null, remaining:number}}
 */
function check(ip, username) {
  const now = Date.now();
  prune(now);

  const user = usernameKey(username);
  const pair = pairKey(ip, user);

  const userEntry = attemptsByUser.get(user);
  if (userEntry && userEntry.lockedUntil > now) {
    const retryAfter = Math.ceil((userEntry.lockedUntil - now) / 1000);
    return {
      allowed: false,
      retryAfter,
      lockedUntil: userEntry.lockedUntil,
      reason: 'locked',
      remaining: 0,
    };
  }

  const pairEntry = attemptsByIpUser.get(pair);
  if (!pairEntry || pairEntry.fails < policy.freeAttempts) {
    const remaining = pairEntry ? Math.max(0, policy.freeAttempts - pairEntry.fails) : policy.freeAttempts;
    return { allowed: true, retryAfter: 0, lockedUntil: null, reason: null, remaining };
  }

  // Sudah melewati ambang: tunggu makin lama setiap percobaan tambahan.
  const over = pairEntry.fails - policy.freeAttempts + 1;
  const delay = Math.min(policy.baseDelaySeconds * over, policy.maxDelaySeconds);
  const readyAt = pairEntry.lastFailAt + delay * 1000;

  if (now >= readyAt) {
    return {
      allowed: true,
      retryAfter: 0,
      lockedUntil: null,
      reason: null,
      remaining: 0,
    };
  }

  return {
    allowed: false,
    retryAfter: Math.ceil((readyAt - now) / 1000),
    lockedUntil: null,
    reason: 'throttled',
    remaining: 0,
  };
}

/** Catat satu percobaan login gagal. */
function registerFailure(ip, username) {
  const now = Date.now();
  const user = usernameKey(username);
  const pair = pairKey(ip, user);

  const pairEntry = attemptsByIpUser.get(pair) || { fails: 0, lastFailAt: now };
  pairEntry.fails += 1;
  pairEntry.lastFailAt = now;
  if (pairEntry.firstFailAt === undefined) pairEntry.firstFailAt = now;
  attemptsByIpUser.set(pair, pairEntry);

  const userEntry = attemptsByUser.get(user) || { fails: 0, lockedUntil: 0, lastFailAt: now };
  userEntry.fails += 1;
  userEntry.lastFailAt = now;
  if (userEntry.fails >= policy.lockThreshold) {
    userEntry.lockedUntil = now + policy.lockSeconds * 1000;
    userEntry.fails = 0;
  }
  attemptsByUser.set(user, userEntry);

  const ipEntry = ipFails.get(ip) || { fails: 0, lastFailAt: now };
  ipEntry.fails += 1;
  ipEntry.lastFailAt = now;
  ipFails.set(ip, ipEntry);

  return { fails: pairEntry.fails };
}

/** Bersihkan riwayat setelah login berhasil. */
function registerSuccess(ip, username) {
  const user = usernameKey(username);
  attemptsByIpUser.delete(pairKey(ip, user));

  // Login berhasil tidak menghapus riwayat username secara keseluruhan bila
  // ada IP lain yang masih gagal, tapi cukup untuk pemakaian normal.
  const userEntry = attemptsByUser.get(user);
  if (userEntry && userEntry.lockedUntil <= Date.now()) userEntry.fails = 0;
}

/** Kosongkan semua state (dipakai tes dan reset manual). */
function reset() {
  attemptsByIpUser.clear();
  attemptsByUser.clear();
  ipFails.clear();
}

/** Ambil policy aktif (bisa dioverride dari tabel settings). */
function getPolicy() {
  return { ...policy, keys: DEFAULTS.settingKeys };
}

/** Terapkan nilai dari tabel settings. Nilai tidak valid diabaikan. */
function applySettings(stored = {}) {
  const keys = DEFAULTS.settingKeys;

  if (stored[keys.enabled] !== undefined) {
    policy.enabled = ['1', 'true', 'yes', 'on'].includes(String(stored[keys.enabled]).trim().toLowerCase());
  }

  const int = (value, min, max, fallback) => {
    if (value === undefined) return fallback;
    const n = Number.parseInt(String(value).trim(), 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  policy.freeAttempts = int(stored[keys.freeAttempts], 1, 100, policy.freeAttempts);
  policy.lockThreshold = int(stored[keys.lockThreshold], 1, 1000, policy.lockThreshold);
  policy.lockSeconds = int(stored[keys.lockSeconds], 30, 86400, policy.lockSeconds);

  return policy;
}

module.exports = {
  DEFAULTS,
  check,
  registerFailure,
  registerSuccess,
  reset,
  getPolicy,
  applySettings,
};
