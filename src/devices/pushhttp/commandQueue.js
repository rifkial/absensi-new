'use strict';

const { EventEmitter } = require('node:events');

/**
 * Antrean perintah per mesin untuk protokol PUSH.
 *
 * Cara kerja (mengikuti spesifikasi PUSH SDK):
 *   1. Mesin melakukan long-poll GET /iclock/getrequest?SN=xxx
 *   2. Bila antrean kosong -> server balas "OK", mesin menunggu lalu mengulang
 *   3. Bila antrean berisi  -> server balas "C:<id>:<VERB> <ARGS>"
 *   4. Mesin mengerjakan lalu POST hasil ke /iclock/devicecmd?SN=xxx
 *   5. resolveCommand() dipanggil, promise pemanggil terpenuhi
 *
 * Timeout long-poll penting: mesin menahan koneksi, jadi jangan pakai
 * timeout Express yang pendek. Default 25 detik.
 */
const LONG_POLL_TIMEOUT_MS = 25000;
const COMMAND_TIMEOUT_MS = 60000;

class CommandQueue extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, {queue: Array, waiting: Array, dispatched: Map}>} */
    this.channels = new Map();
    this._seq = 0;
    this._pollTimers = new Map();
  }

  _channel(sn) {
    if (!this.channels.has(sn)) {
      this.channels.set(sn, { queue: [], waiting: [], dispatched: new Map() });
    }
    return this.channels.get(sn);
  }

  /** Masukkan perintah dan tunggu mesin mengirim balik hasil. */
  enqueue(sn, verb, args = '') {
    this._seq += 1;
    const id = this._seq;
    const line = `C:${id}:${verb}${args ? ' ' + args : ''}`;
    const channel = this._channel(sn);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.dispatched.delete(id);
        channel.queue = channel.queue.filter((c) => c.id !== id);
        reject(new Error(`Mesin ${sn} tidak menjawab perintah "${verb}" dalam ${COMMAND_TIMEOUT_MS / 1000} detik. ` +
          'Pastikan mesin dikonfigurasi mode PUSH/ADMS dan IP server sudah benar.'));
      }, COMMAND_TIMEOUT_MS);

      const entry = { id, verb, line, resolve, reject, timer };

      // Bila mesin sedang menunggu (long-poll aktif), kirim sekarang juga.
      const waiter = channel.waiting.shift();
      if (waiter) {
        channel.dispatched.set(id, entry);
        waiter.resolve(line);
      } else {
        channel.queue.push(entry);
      }
    });
  }

  /** Dipanggil handler /iclock/getrequest. Balas 'OK' bila antrean kosong. */
  poll(sn, timeoutMs = LONG_POLL_TIMEOUT_MS) {
    const channel = this._channel(sn);

    return new Promise((resolve) => {
      if (channel.queue.length > 0) {
        const entry = channel.queue.shift();
        channel.dispatched.set(entry.id, entry);
        resolve(entry.line);
        return;
      }

      channel.waiting.push({ resolve });
      const timer = setTimeout(() => {
        const index = channel.waiting.findIndex((w) => w.resolve === resolve);
        if (index >= 0) channel.waiting.splice(index, 1);
        this._pollTimers.delete(sn);
        resolve('OK');
      }, timeoutMs);

      this._pollTimers.set(sn, timer);
    });
  }

  /** Dipanggil handler /iclock/devicecmd. */
  complete(sn, reply) {
    const channel = this._channel(sn);
    const id = reply.id !== null ? Number(reply.id) : null;

    let entry = id !== null ? channel.dispatched.get(id) : null;
    if (!entry && channel.dispatched.size === 1) {
      // Beberapa firmware tidak mengembalikan ID dengan benar: ambil satu-satunya.
      entry = [...channel.dispatched.values()][0];
    }

    if (!entry) {
      this.emit('orphan', { sn, reply });
      return false;
    }

    channel.dispatched.delete(entry.id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
    return true;
  }

  /** Batalkan semua perintah untuk satu mesin (mis. saat disconnect). */
  clear(sn) {
    const channel = this.channels.get(sn);
    if (!channel) return;

    const timer = this._pollTimers.get(sn);
    if (timer) {
      clearTimeout(timer);
      this._pollTimers.delete(sn);
    }

    for (const entry of [...channel.queue, ...channel.dispatched.values()]) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Koneksi PUSH dari mesin ${sn} terputus sebelum perintah dijawab.`));
    }

    channel.queue = [];
    channel.dispatched.clear();
    for (const waiter of channel.waiting.splice(0)) waiter.resolve('OK');
  }

  stats() {
    const out = {};
    for (const [sn, channel] of this.channels) {
      out[sn] = {
        queued: channel.queue.length,
        dispatched: channel.dispatched.size,
        waiting: channel.waiting.length,
      };
    }
    return out;
  }

  destroy() {
    for (const sn of [...this.channels.keys()]) this.clear(sn);
    this.channels.clear();
  }
}

module.exports = { CommandQueue, LONG_POLL_TIMEOUT_MS, COMMAND_TIMEOUT_MS };
