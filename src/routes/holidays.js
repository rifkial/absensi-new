'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const holidays = require('../services/holidays');
const attendance = require('../services/attendance');
const audit = require('../services/audit');

const router = express.Router();

router.use(auth.requireAuth);

/** Daftar hari libur per tahun. */
router.get(
  '/',
  auth.requirePermission('holidays:read'),
  wrap(async (req, res) => {
    const { year, from, to } = req.query;

    if (year) {
      const data = await holidays.listByYear(year);
      return res.json({ ok: true, data });
    }

    if (from || to) {
      const data = await holidays.listBetween(from, to);
      return res.json({ ok: true, data });
    }

    throw badRequest('Sertakan query year, atau rentang from dan to.');
  })
);

/** Ringkasan + daftar hari libur yang akan datang. */
router.get(
  '/upcoming',
  auth.requirePermission('holidays:read'),
  wrap(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 45));
    const data = await holidays.upcoming(days);
    res.json({ ok: true, data });
  })
);

/** Status sinkron otomatis + sumber data yang dipakai. */
router.get(
  '/sync-status',
  auth.requirePermission('holidays:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await holidays.syncStatus() });
  })
);

/** Tambahkan hari libur manual (mis. hari libur perusahaan). */
router.post(
  '/',
  auth.requirePermission('holidays:write'),
  wrap(async (req, res) => {
    const holiday = await holidays.create(req.body || {}, req.user.id);

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'holiday.create',
      entity: 'holidays',
      entityId: holiday.id,
      detail: { tanggal: holiday.holiday_date, nama: holiday.name, jenis: holiday.kind },
    });

    res.status(201).json({ ok: true, data: holiday });
  })
);

router.put(
  '/:id',
  auth.requirePermission('holidays:write'),
  wrap(async (req, res) => {
    const before = await holidays.getOrFail(Number(req.params.id));
    const holiday = await holidays.update(Number(req.params.id), req.body || {});

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'holiday.update',
      entity: 'holidays',
      entityId: holiday.id,
      before,
      after: holiday,
    });

    res.json({ ok: true, data: holiday });
  })
);

router.delete(
  '/:id',
  auth.requirePermission('holidays:write'),
  wrap(async (req, res) => {
    const result = await holidays.remove(Number(req.params.id));

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'holiday.delete',
      entity: 'holidays',
      entityId: result.holiday.id,
      detail: { tanggal: result.holiday.holiday_date, nama: result.holiday.name },
    });

    res.json({ ok: true, ...result });
  })
);

/**
 * Sinkronkan hari libur nasional dari API.
 *
 * Destinya opsional: bila diisi, rekap absensi dihitung ulang untuk rentang
 * tanggal tersebut supaya changes langsung terlihat di laporan.
 */
router.post(
  '/sync',
  auth.requirePermission('holidays:write'),
  wrap(async (req, res) => {
    const now = new Date();
    const thisYear = Number.parseInt(req.body?.year, 10) || now.getFullYear();
    const nextYear = Number.parseInt(req.body?.to_year, 10) || thisYear + 1;
    const withRecalc = req.body?.recalculate !== false;

    const result = await holidays.syncRange(thisYear, nextYear);

    let recalculated = null;
    if (withRecalc) {
      const from = `${result.years[0]}-01-01`;
      const to = `${result.years[result.years.length - 1]}-12-31`;
      recalculated = await attendance.generate({ from, to });
    }

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'holiday.sync',
      entity: 'holidays',
      entityId: null,
      detail: { years: result.years.join(','), ...result.results[0] },
    });

    res.json({
      ok: true,
      data: result,
      recalculated,
      message: result.message + (recalculated ? ` Rekap ${recalculated.processed} baris dihitung ulang.` : ''),
    });
  })
);

/** Buang semua hari libur hasil sinkronisasi (data manual tetap). */
router.post(
  '/clear-synced',
  auth.requirePermission('holidays:write'),
  wrap(async (req, res) => {
    const removed = await holidays.removeSynced();

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'holiday.clear_synced',
      entity: 'holidays',
      entityId: null,
      detail: { removed },
    });

    res.json({ ok: true, data: { removed }, message: `${removed} hari libur hasil sinkronisasi dihapus.` });
  })
);

module.exports = router;
