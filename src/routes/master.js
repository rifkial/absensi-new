'use strict';

/**
 * Data master: unit kerja (divisi/departemen) dan jabatan.
 *
 * Keduanya adalah referensi sederhana yang dipakai sebagai pilihan dropdown
 * di form karyawan, filter laporan/absensi, dan jadwal massal.
 */

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const master = require('../services/master');
const audit = require('../services/audit');

const router = express.Router();

router.use(auth.requireAuth);

const KINDS = {
  departments: { label: 'unit kerja', entity: 'departments' },
  positions: { label: 'jabatan', entity: 'positions' },
};

function kindOf(value) {
  const kind = KINDS[value];
  if (!kind) throw badRequest(`Jenis data master tidak dikenal: ${value}`);
  return kind;
}

function mount(kind) {
  const { label, entity } = kindOf(kind);

  router.get(
    `/${kind}`,
    auth.requirePermission('master:read'),
    wrap(async (req, res) => {
      res.json({ ok: true, data: await master.list(kind) });
    })
  );

  router.get(
    `/${kind}/:id`,
    auth.requirePermission('master:read'),
    wrap(async (req, res) => {
      res.json({ ok: true, data: await master.getOrFail(kind, Number(req.params.id)) });
    })
  );

  router.post(
    `/${kind}`,
    auth.requirePermission('master:write'),
    wrap(async (req, res) => {
      const row = await master.create(kind, req.body || {});

      await audit.record({
        userId: req.user.id,
        ip: audit.ipOf(req),
        action: `${entity}.create`,
        entity,
        entityId: row.id,
        detail: row,
      });

      res.status(201).json({ ok: true, data: row });
    })
  );

  router.put(
    `/${kind}/:id`,
    auth.requirePermission('master:write'),
    wrap(async (req, res) => {
      const before = await master.getOrFail(kind, Number(req.params.id));
      const row = await master.update(kind, Number(req.params.id), req.body || {});

      await audit.recordChange({
        userId: req.user.id,
        ip: audit.ipOf(req),
        action: `${entity}.update`,
        entity,
        entityId: row.id,
        before,
        after: row,
      });

      res.json({ ok: true, data: row });
    })
  );

  router.delete(
    `/${kind}/:id`,
    auth.requirePermission('master:write'),
    wrap(async (req, res) => {
      const result = await master.remove(kind, Number(req.params.id));

      await audit.record({
        userId: req.user.id,
        ip: audit.ipOf(req),
        action: `${entity}.delete`,
        entity,
        entityId: Number(req.params.id),
        detail: { [label]: result.row },
      });

      res.json({ ok: true, ...result });
    })
  );
}

mount('departments');
mount('positions');

module.exports = router;
