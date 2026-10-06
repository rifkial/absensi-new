'use strict';

const config = require('../config');

/**
 * Reverse geocoding: koordinat -> nama lokasi, kecamatan, kota/kabupaten, provinsi.
 *
 * Memakai Nominatim (OpenStreetMap): gratis, tanpa API key. Dua syarat dari
 * provider itu yang menentukan bentuk kode di bawah: maksimal 1 permintaan/detik
 * dan wajib menyertakan User-Agent. Karena itu ada jeda antar-request (throttle)
 * dan cache in-memory, sehingga check-in di lokasi yang sama tidak memanggil
 * provider berulang kali.
 *
 * Kegagalan TIDAK pernah dilempar ke pemanggil: check-in dinas luar harus tetap
 * berhasil walau internet mati atau provider sedang down. Fungsi selalu
 * mengembalikan objek lengkap dengan nilai null di kolom yang tidak diketahui.
 */

const CACHE = new Map();
let lastRequestAt = 0;

// TTL negative cache (hasil gagal) jauh lebih pendek daripada TTL sukses,
// supaya lokasi yang sebelumnya gagal masih dicoba lagi pada check-in berikutnya.
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Kunci cache dibulatkan ke 4 desimal (~11 m) supaya koordinat yang berbeda
 * beberapa meter di lokasi yang sama tetap memakai satu entri cache.
 */
function cacheKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function pruneCache(now) {
  for (const [key, entry] of CACHE) {
    if (now - entry.at > entry.ttl) CACHE.delete(key);
  }
}

/** Jeda minimal antar-request agar tidak melanggar batas 1 req/detik. */
async function throttle() {
  const wait = config.geocode.minIntervalMs - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/** Buang bagian kosong maupun duplikat (case-insensitive). */
function uniqueParts(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const value = String(part || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Susun nama lokasi yang enak dibaca dari bagian-bagian hasil geocoding.
 * Urutan: nama jalan (+nomor rumah) > lingkungan > kelurahan/desa > kecamatan.
 */
function formatAddress(addr = {}) {
  let road = addr.road || addr.pedestrian || '';
  if (road && addr.house_number) road = `${road} No. ${addr.house_number}`;

  return uniqueParts([
    road,
    addr.neighbourhood,
    addr.village || addr.hamlet,
    addr.suburb,
    addr.city_district,
  ]).join(', ');
}

/**
 * Ambil nama lokasi dari koordinat.
 * @returns {Promise<{address:string|null, district:string|null, city:string|null,
 *   province:string|null, formatted:string|null}>}
 */
async function reverse(latitude, longitude) {
  const empty = {
    address: null,
    district: null,
    city: null,
    province: null,
    formatted: null,
  };

  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return empty;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return empty;
  if (!config.geocode.enabled) return empty;

  const key = cacheKey(lat, lon);
  const now = Date.now();
  pruneCache(now);

  const cached = CACHE.get(key);
  if (cached && now - cached.at < cached.ttl) return cached.value;

  const url =
    `${config.geocode.baseUrl.replace(/\/+$/, '')}/reverse` +
    `?format=jsonv2&lat=${lat}&lon=${lon}` +
    `&zoom=18&addressdetails=1&accept-language=${encodeURIComponent(config.geocode.language)}`;

  try {
    await throttle();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.geocode.timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': config.geocode.userAgent,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      // Tidak ada objek nearby di koordinat itu; hasil kosong ini valid.
      CACHE.set(key, { at: Date.now(), ttl: config.geocode.cacheTtlMs, value: empty });
      return empty;
    }
    if (!res.ok) {
      throw new Error(`provider membalas HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data || data.error) {
      CACHE.set(key, { at: Date.now(), ttl: config.geocode.cacheTtlMs, value: empty });
      return empty;
    }

    const addr = data.address || {};
    const value = {
      address: formatAddress(addr),
      district: addr.city_district || addr.suburb || addr.village || addr.town || null,
      city: addr.city || addr.town || addr.county || addr.municipality || null,
      province: addr.state || addr.region || null,
      formatted: data.display_name || null,
    };

    CACHE.set(key, { at: Date.now(), ttl: config.geocode.cacheTtlMs, value });
    return value;
  } catch (err) {
    // Timeout, DNS gagal, atau offline. Jangan gagalkan check-in.
    console.warn(`[geocode] gagal membaca lokasi (${lat}, ${lon}): ${err.message}`);
    CACHE.set(key, { at: Date.now(), ttl: NEGATIVE_TTL_MS, value: empty });
    return empty;
  }
}

module.exports = { reverse, formatAddress };