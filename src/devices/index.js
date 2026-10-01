'use strict';

const { adapter: zktecoAdapter } = require('./zkteco4370/adapter');
const { pushAdapter } = require('./pushhttp/adapter');
const { adapter: csvAdapter } = require('./csv/adapter');

/**
 * Registry adapter perangkat.
 *
 * Menambah dukungan merek/prototol baru cukup dengan menulis objek yang
 * punya antarmuka sama, lalu mendaftarkannya di sini:
 *
 *   {
 *     protocol: 'nama-protokol',
 *     label: 'Teks untuk UI',
 *     description: 'Penjelasan singkat',
 *     async test(device)  -> { ok, message, info? }
 *     async sync(device, options?) -> { ok, fetched, inserted, duplicated, unmatched, message }
 *   }
 */
const ADAPTERS = new Map([
  [zktecoAdapter.protocol, zktecoAdapter],
  [pushAdapter.protocol, pushAdapter],
  [csvAdapter.protocol, csvAdapter],
]);

const DEFAULT_PROTOCOL = 'zkteco-tcp';

function getAdapter(protocol) {
  const adapter = ADAPTERS.get(protocol);
  if (!adapter) {
    throw new Error(`Protokol "${protocol}" tidak dikenali. Pilihan yang tersedia: ${[...ADAPTERS.keys()].join(', ')}.`);
  }
  return adapter;
}

function hasAdapter(protocol) {
  return ADAPTERS.has(protocol);
}

function listProtocols() {
  return [...ADAPTERS.values()].map((a) => ({
    protocol: a.protocol,
    label: a.label,
    description: a.description,
  }));
}

module.exports = {
  ADAPTERS,
  DEFAULT_PROTOCOL,
  getAdapter,
  hasAdapter,
  listProtocols,
  zktecoAdapter,
  pushAdapter,
  csvAdapter,
};
