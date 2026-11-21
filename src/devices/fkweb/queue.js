'use strict';

/**
 * Antrean perintah FkWeb per perangkat.
 *
 * Mesin FkWeb adalah klien: ia memanggil `receive_cmd` berkala untuk mengambil
 * satu perintah. Perintah yang sudah diambil disimpan sampai mesin mengirim
 * `send_cmd_result` dengan `trans_id` yang sama.
 */
class CommandQueue {
  constructor() {
    this.pending = new Map(); // `${devId}:${transId}` -> entry
    this.byDevice = new Map(); // devId -> entry[]
    this.seq = 0;
  }

  /** Kirim satu perintah; promise selesai saat mesin mengembalikan hasil. */
  enqueue(devId, code, param = Buffer.alloc(0), timeoutMs = 120000) {
    this.seq += 1;
    const transId = String(this.seq);
    const key = `${devId}:${transId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this._remove(devId, transId);
        reject(new Error(
          `Mesin FkWeb ${devId} tidak menjawab perintah "${code}" dalam ${Math.round(timeoutMs / 1000)} detik. ` +
          'Pastikan mesin mode Internet, Server IP/Port benar, dan Server Req = Ya.'
        ));
      }, timeoutMs);

      const entry = { devId, transId, code, param, resolve, reject, timer };
      this.pending.set(key, entry);
      if (!this.byDevice.has(devId)) this.byDevice.set(devId, []);
      this.byDevice.get(devId).push(entry);
    });
  }

  /** Ambil perintah berikutnya untuk mesin; null bila antrean kosong. */
  next(devId) {
    const list = this.byDevice.get(devId);
    if (!list || list.length === 0) return null;
    return list.shift();
  }

  /** Selesaikan perintah dari `send_cmd_result`. */
  complete(devId, transId, result) {
    const key = `${devId}:${transId}`;
    const entry = this.pending.get(key);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(key);
    this._remove(devId, transId);
    entry.resolve(result);
    return true;
  }

  _remove(devId, transId) {
    const list = this.byDevice.get(devId);
    if (!list) return;
    const index = list.findIndex((e) => e.transId === transId);
    if (index >= 0) list.splice(index, 1);
  }

  stats() {
    const out = {};
    for (const [devId, list] of this.byDevice) {
      out[devId] = list.map((e) => ({ trans_id: e.transId, cmd_code: e.code }));
    }
    return out;
  }
}

module.exports = { CommandQueue };