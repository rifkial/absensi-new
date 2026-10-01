'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

const {
  COMMANDS,
  USHRT_MAX,
  MAX_CHUNK,
  PREFIX_LENGTH,
  FRAME_HEADER_LENGTH,
  REQUEST_DATA,
  RECORD_SIZE,
} = require('./constants');

const codec = require('./codec');

/**
 * Client TCP untuk protokol ZKTeco Standalone SDK (port 4370).
 *
 * Alur sesi:
 *   1. CMD_CONNECT  -> mesin membalas frame yang memuat session id baru
 *   2. ... perintah data ...
 *   3. CMD_EXIT     -> tutup koneksi dengan rapi
 *
 * Transfer data massal (log absensi / user) memakai 3 langkah:
 *   CMD_DATA_WRRQ -> CMD_PREPARE_DATA (total size) -> CMD_DATA_RDY per chunk
 */
class ZkTcpClient extends EventEmitter {
  constructor({ host, port = 4370, timeout = 20000, password = 0 } = {}) {
    super();
    this.host = host;
    this.port = port || 4370;
    this.timeout = timeout;
    this.password = password;

    this.sessionId = 0;
    this.replyId = 0;
    this.socket = null;
    this.connected = false;
    this.deviceName = null;

    this._rx = Buffer.alloc(0);
    this._pending = []; // { matcher, resolve, reject, timer }
    this._chunkWaiters = new Map(); // size bytes -> resolve
    this._closing = false;
  }

  // -------------------------------------------------------------------------
  // Koneksi
  // -------------------------------------------------------------------------

  async connect() {
    if (this.connected) return true;

    await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;

      const onConnectError = (err) => {
        socket.destroy();
        reject(
          new Error(
            `Tidak bisa terhubung ke ${this.host}:${this.port} - ${err.message}. ` +
              'Periksa IP, kabel LAN, dan menu Comm/Network pada mesin.'
          )
        );
      };

      socket.once('error', onConnectError);
      socket.setTimeout(this.timeout);
      socket.once('connect', async () => {
        socket.removeListener('error', onConnectError);

        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._failAll(err));
        socket.on('close', () => this._onClose());
        socket.on('timeout', () => {
          this._failAll(new Error(`Timeout ${this.timeout}ms saat komunikasi dengan mesin`));
          socket.destroy();
        });

        try {
          await this._handshake();
          resolve();
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });

      socket.connect(this.port, this.host);
    });

    this.connected = true;
    return true;
  }

  async _handshake() {
    const reply = await this.executeCmd(COMMANDS.CMD_CONNECT, this.password ? this._encodePassword() : Buffer.alloc(0));

    if (reply && reply.length >= 6) {
      // session id berada di byte 4..5 dari payload header
      this.sessionId = reply.readUInt16LE(4);
    }

    if (this.sessionId === 0) {
      throw new Error('Mesin menerima koneksi tetapi tidak memberi session id (mungkin perlu password).');
    }

    // Nonaktifkan display supaya mesin tidak terkunci selama sync yang panjang.
    try {
      await this.executeCmd(COMMANDS.CMD_DISABLEDEVICE, REQUEST_DATA.DISABLE_DEVICE);
    } catch {
      // Tidak semua firmware mendukung; abaikan.
    }
  }

  _encodePassword() {
    const buf = Buffer.alloc(9);
    codec.writeAscii(buf, 0, 8, String(this.password));
    buf.writeUInt8(1, 8);
    return buf;
  }

  async disconnect() {
    if (!this.socket) return;
    this._closing = true;
    try {
      if (this.connected) {
        await this.executeCmd(COMMANDS.CMD_EXIT, Buffer.alloc(0));
      }
    } catch {
      // abaikan
    }
    this._destroySocket();
  }

  _destroySocket() {
    if (!this.socket) return;
    this.socket.removeAllListeners('data');
    this.socket.destroy();
    this.socket = null;
    this.connected = false;
  }

  _onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    this._rx = Buffer.alloc(0);
    if (wasConnected && !this._closing) {
      this._failAll(new Error('Koneksi ke mesin terputus (device dimatikan / kabel dilepas).'));
    }
    this._closing = false;
    this.emit('close');
  }

  _failAll(err) {
    const pending = this._pending.splice(0);
    for (const item of pending) {
      clearTimeout(item.timer);
      item.reject(err);
    }
    for (const [, waiter] of this._chunkWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this._chunkWaiters.clear();
  }

  // -------------------------------------------------------------------------
  // Framing & dispatch
  // -------------------------------------------------------------------------

  _onData(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);

    while (this._rx.length >= PREFIX_LENGTH) {
      if (!codec.isValidMagic(this._rx)) {
        // Buang 1 byte dan cari ulang magic (sinkronisasi stream yang geser).
        this._rx = this._rx.subarray(1);
        continue;
      }

      const header = codec.decodeFrameHeader(this._rx);
      if (header.totalLength > this._rx.length) break; // frame belum lengkap

      const frame = this._rx.subarray(0, header.totalLength);
      this._rx = this._rx.subarray(header.totalLength);

      try {
        this._dispatch(frame);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  _dispatch(frame) {
    // Event realtime: teruskan ke listener, jangananswered sebagai response perintah.
    if (codec.isEventFrame(frame)) {
      const payload = frame.subarray(FRAME_HEADER_LENGTH);
      try {
        const record = codec.decodeRealtimeRecord(payload);
        this.emit('attlog', record);
      } catch (err) {
        this.emit('warn', `Gagal decode realtime log: ${err.message}`);
      }
      return;
    }

    const header = codec.decodeFrameHeader(frame);
    const payload = frame.subarray(PREFIX_LENGTH); // payload header + data

    // 1) Antwort untuk transfer data massal
    for (const [size, waiter] of this._chunkWaiters) {
      if (waiter.resolve) {
        this._chunkWaiters.delete(size);
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
        return;
      }
    }

    // 2) Jawaban perintah biasa
    const pending = this._pending[0];
    if (pending) {
      this._pending.shift();
      clearTimeout(pending.timer);

      if (pending.command === COMMANDS.CMD_CONNECT) {
        pending.resolve(payload);
        return;
      }

      if (header.command >= 2000 && header.command !== COMMANDS.CMD_ACK_OK) {
        pending.reject(new Error(`Mesin menolak perintah ${pending.name}: ${codec.commandName(header.command)}`));
        return;
      }

      pending.resolve(payload);
      return;
    }

    this.emit('warn', `Frame tak berpasangan: ${codec.commandName(header.command)}`);
  }

  // -------------------------------------------------------------------------
  // Perintah
  // -------------------------------------------------------------------------

  /**
   * Kirim satu perintah dan tunggu frame balasan pertama.
   * Resolve dengan payload (payload header 8 byte + data).
   */
  executeCmd(command, data = Buffer.alloc(0)) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket belum terhubung.'));
        return;
      }

      if (command === COMMANDS.CMD_CONNECT) {
        this.sessionId = 0;
        this.replyId = 0;
      } else {
        this.replyId = (this.replyId + 1) % USHRT_MAX;
      }

      const frame = codec.buildFrame(command, this.sessionId, this.replyId, data);
      const name = codec.commandName(command);

      const timer = setTimeout(() => {
        const index = this._pending.findIndex((p) => p.timer === timer);
        if (index >= 0) this._pending.splice(index, 1);
        reject(new Error(`Timeout ${this.timeout}ms menunggu balasan ${name}`));
      }, this.timeout);

      this._pending.push({ command, name, resolve, reject, timer });
      this.socket.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          const index = this._pending.findIndex((p) => p.timer === timer);
          if (index >= 0) this._pending.splice(index, 1);
          reject(err);
        }
      });
    });
  }

  /**
   * Transfer data massal: kirim CMD_DATA_WRRQ lalu kumpulkan seluruh chunk.
   * `requestData` harus salah satu REQUEST_DATA di constants.js.
   */
  async readBulk(requestData, { onProgress, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
    await this.freeData();

    let first;
    try {
      first = await this.executeCmd(COMMANDS.CMD_DATA_WRRQ, requestData);
    } catch (err) {
      throw new Error(`Permintaan data ditolak: ${err.message}`);
    }

    const header = codec.decodeFrameHeader(first);

    // Sebagian firmware langsung mengirim CMD_DATA dalam 1 frame tanpa chunking.
    if (header.command === COMMANDS.CMD_DATA) {
      await this.freeData();
      return first.subarray(PREFIX_LENGTH);
    }

    if (header.command !== COMMANDS.CMD_PREPARE_DATA && header.command !== COMMANDS.CMD_ACK_OK) {
      await this.freeData();
      throw new Error(`Respons tak terduga: ${codec.commandName(header.command)}`);
    }

    // Header CMD_PREPARE_DATA memuat N1..N4; N3 = total ukuran data.
    const info = first.subarray(PREFIX_LENGTH);
    const totalSize = info.readUInt16LE(4);
    if (totalSize <= 0) {
      await this.freeData();
      return Buffer.alloc(0);
    }
    if (totalSize > maxTotalBytes) {
      await this.freeData();
      throw new Error(`Ukuran data ${totalSize} byte melebihi batas ${maxTotalBytes} byte.`);
    }

    const fullChunk = Math.floor(totalSize / MAX_CHUNK);
    const remain = totalSize % MAX_CHUNK;
    const totalPackets = remain > 0 ? fullChunk + 1 : fullChunk;

    if (totalPackets > 512) {
      await this.freeData();
      throw new Error(`Terlalu banyak chunk (${totalPackets}). Kemungkinan mesin dalam kondisi tidak stabil.`);
    }

    const collected = [];
    let received = 0;

    for (let index = 0; index < totalPackets; index += 1) {
      const offset = index * MAX_CHUNK;
      const length = index === fullChunk ? remain : MAX_CHUNK;

      const payload = await this._requestChunk(offset, length);
      const chunkHeader = codec.decodeFrameHeader(payload);
      // Setiap chunk berisi payload header (8) + N-block (8) + data
      const dataStart = PREFIX_LENGTH;
      const dataEnd = dataStart + Math.max(0, chunkHeader.payloadLength - PAYLOAD_HEADER_LENGTH);
      const chunk = payload.subarray(dataStart, Math.min(dataEnd, payload.length));

      collected.push(chunk);
      received += chunk.length;

      if (onProgress) onProgress({ received, total: totalSize, packet: index + 1, packets: totalPackets });

      if (received >= totalSize) break;
    }

    await this.freeData();
    return Buffer.concat(collected).subarray(0, totalSize);
  }

  _requestChunk(offset, length) {
    return new Promise((resolve, reject) => {
      const req = Buffer.alloc(8);
      req.writeUInt32LE(offset, 0);
      req.writeUInt32LE(length, 4);

      this.replyId = (this.replyId + 1) % USHRT_MAX;
      const frame = codec.buildFrame(COMMANDS.CMD_DATA_RDY, this.sessionId, this.replyId, req);

      const key = `${offset}:${length}`;
      const timer = setTimeout(() => {
        this._chunkWaiters.delete(key);
        reject(new Error(`Timeout ${this.timeout}ms menunggu chunk @${offset} (+${length} byte)`));
      }, this.timeout);

      this._chunkWaiters.set(key, { resolve, reject, timer });
      this.socket.write(frame, (err) => {
        if (err) {
          clearTimeout(timer);
          this._chunkWaiters.delete(key);
          reject(err);
        }
      });
    });
  }

  async freeData() {
    try {
      await this.executeCmd(COMMANDS.CMD_FREE_DATA, Buffer.alloc(0));
    } catch {
      // FW lama tidak selalu ACK; aman diabaikan.
    }
  }

  // -------------------------------------------------------------------------
  // API tingkat tinggi
  // -------------------------------------------------------------------------

  /** Ambil seluruh log absensi dari mesin. */
  async getAttendanceLogs(options = {}) {
    const buffer = await this.readBulk(REQUEST_DATA.GET_ATTENDANCE_LOGS, options);
    return codec.splitRecords(buffer, RECORD_SIZE.ATTENDANCE, codec.decodeAttendanceRecord);
  }

  /** Ambil seluruh user yang terdaftar di mesin. */
  async getUsers(options = {}) {
    const buffer = await this.readBulk(REQUEST_DATA.GET_USERS, options);
    return codec.splitRecords(buffer, RECORD_SIZE.USER, codec.decodeUserRecord);
  }

  /** Informasi kapasitas & identitas dasar mesin. */
  async getInfo() {
    const payload = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, Buffer.alloc(0));
    const info = {};

    // timeoutoffset) =>
      offset + 4 <= payload.length ? payload.readUInt32LE(offset) : null;

    info.users = readU32(4);
    info.fingers = readU32(8);
    info.records = readU32(12);
    info.usersMax = readU32(24);
    info.fingersMax = readU32(28);
    info.recordsMax = readU32(32);
    info.recordsCapacity = readU32(40);

    // Nama perangkat & versi firmware ada di blok trailing, kadang tidak ASCII rapi.
    info.raw = payload.toString('hex');

    try {
      const version = await this.getFirmwareVersion();
      info.firmwareVersion = version;
    } catch {
      info.firmwareVersion = null;
    }

    return info;
  }

  async getFirmwareVersion() {
    const payload = await this.executeCmd(COMMANDS.CMD_GET_VERSION, Buffer.alloc(0));
    if (!payload || payload.length <= 8) return null;
    return codec.readAscii(payload.subarray(8));
  }

  /** Hapus semua log di mesin. HATI-HATI: data hilang permanen. */
  async clearAttendanceLogs() {
    await this.executeCmd(COMMANDS.CMD_CLEAR_ATTLOG, Buffer.alloc(0));
  }

  /**
   * Streaming log realtime (CMD_REG_EVENT). Mesin akanREAM mengirimi log
   * selama koneksi terbuka. Dipakai untuk tampilan absensi live.
   */
  startRealtime(onLog) {
    if (!this.socket) throw new Error('Socket belum terhubung.');

    this.replyId = (this.replyId + 1) % USHRT_MAX;
    const frame = codec.buildFrame(
      COMMANDS.CMD_REG_EVENT,
      this.sessionId,
      this.replyId,
      REQUEST_DATA.GET_REAL_TIME_EVENT
    );
    this.socket.write(frame);

    if (onLog) this.on('attlog', onLog);
    return true;
  }
}


module.exports = { ZkTcpClient };
