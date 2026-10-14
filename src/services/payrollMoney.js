'use strict';

/**
 * Util aritmetika uang payroll.
 *
 * Semua nilai disimpan sebagai DECIMAL(14,2) di MySQL. Driver mysql2
 * mengembalikan DECIMAL sebagai string, jadi setiap nilai wajib dinormalkan
 * lewat toNumber() sebelum dihitung. Hasil akhir selalu dibulatkan ke rupiah
 * penuh (ROUND half-up) supaya slip dan rekap konsisten.
 */

/**
 * Normalisasi nilai uang/persen menjadi angka.
 *
 * Menangani dua bentuk:
 *  - DECIMAL MySQL: titik = desimal, mis. "3.7000", "5000000.00"
 *  - format Indonesia: titik = ribuan, koma = desimal, mis. "5.000.000"
 * Aturan: pola ribuan berpemisah titik (grup 3 digit) dianggap format ID.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let s = String(value).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;

  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',') && !s.includes('.')) {
    s = s.replace(',', '.');
  } else if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Rupiah penuh dari nilai apa pun (ROUND half-up). */
function roundIdr(value) {
  return Math.round(toNumber(value));
}

function add(...values) {
  let sum = 0;
  for (const v of values) sum += roundIdr(v);
  return sum;
}

function sub(a, ...rest) {
  let out = roundIdr(a);
  for (const v of rest) out -= roundIdr(v);
  return out;
}

/** a * persen / 100, dibulatkan ke rupiah. */
function percentOf(base, percent) {
  return roundIdr((roundIdr(base) * toNumber(percent)) / 100);
}

/** Format "Rp 1.500.000" untuk tampilan. */
function formatIdr(value) {
  return `Rp ${roundIdr(value).toLocaleString('id-ID')}`;
}

/**
 * Terbilang rupiah Bahasa Indonesia, mis. 1500000 -> "Satu Juta Lima Ratus
 * Ribu Rupiah". Dipakai di slip gaji.
 */
function terbilang(value) {
  let n = Math.abs(Math.trunc(roundIdr(value)));
  if (n === 0) return 'Nol Rupiah';

  const units = ['', 'Satu', 'Dua', 'Tiga', 'Empat', 'Lima', 'Enam', 'Tujuh', 'Delapan', 'Sembilan', 'Sepuluh', 'Sebelas'];

  function spell(num) {
    if (num < 12) return units[num];
    if (num < 20) return `${spell(num - 10)} Belas`;
    if (num < 100) return `${spell(Math.floor(num / 10))} Puluh${num % 10 ? ` ${spell(num % 10)}` : ''}`;
    if (num < 200) return `Seratus${num % 100 ? ` ${spell(num % 100)}` : ''}`;
    if (num < 1000) return `${spell(Math.floor(num / 100))} Ratus${num % 100 ? ` ${spell(num % 100)}` : ''}`;
    if (num < 2000) return `Seribu${num % 1000 ? ` ${spell(num % 1000)}` : ''}`;
    if (num < 1000000) return `${spell(Math.floor(num / 1000))} Ribu${num % 1000 ? ` ${spell(num % 1000)}` : ''}`;
    if (num < 1000000000) return `${spell(Math.floor(num / 1000000))} Juta${num % 1000000 ? ` ${spell(num % 1000000)}` : ''}`;
    if (num < 1000000000000) return `${spell(Math.floor(num / 1000000000))} Miliar${num % 1000000000 ? ` ${spell(num % 1000000000)}` : ''}`;
    return `${spell(Math.floor(num / 1000000000000))} Triliun${num % 1000000000000 ? ` ${spell(num % 1000000000000)}` : ''}`;
  }

  const words = spell(n);
  return `${roundIdr(value) < 0 ? 'Minus ' : ''}${words} Rupiah`;
}

module.exports = { toNumber, roundIdr, add, sub, percentOf, formatIdr, terbilang };
