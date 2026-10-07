'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const reports = require('../services/reports');
const { today, startOfMonth, toDate } = require('../utils/date');

const router = express.Router();

router.use(auth.requireAuth);

/** Format & kolom yang tersedia untuk laporan. */
router.get(
  '/formats',
  auth.requirePermission('reports:read'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: { formats: reports.FORMAT_LIST } });
  })
);

/** Pratinjau laporan (JSON) untuk ditampilkan di UI. */
router.get(
  '/preview',
  auth.requirePermission('reports:read'),
  wrap(async (req, res) => {
    const format = String(req.query.format || 'rekap_harian');
    assertFormat(format);

    const report = await reports.build(format, {
      from: toDate(req.query.from) || startOfMonth(),
      to: toDate(req.query.to) || today(),
      month: req.query.month,
      department_id: req.query.department_id,
      employee_id: req.query.employee_id,
      device_id: req.query.device_id,
      status: req.query.status,
      limit: Math.min(50000, Number(req.query.limit) || 2000),
    });

    // Pagination pratinjau. Ekspor Excel/CSV tetap memakai seluruh baris.
    const perPage = Math.min(2000, Math.max(1, Number(req.query.per_page) || 50));
    const total = report.rows.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(Math.max(1, Number(req.query.page) || 1), totalPages);
    const paged = report.rows.slice((page - 1) * perPage, page * perPage);
    res.json({
      ok: true,
      data: {
        ...report,
        rows: paged,
        meta: { ...report.meta, total, page, per_page: perPage, total_pages: totalPages, returned: paged.length },
      },
    });
  })
);

function assertFormat(format) {
  if (!reports.FORMATS.includes(format)) {
    throw badRequest(`format "${format}" tidak dikenal. Pilihan: ${reports.FORMATS.join(', ')}.`);
  }
}

/** Unduh laporan sebagai Excel. */
router.get(
  '/export/excel',
  auth.requirePermission('reports:export'),
  wrap(async (req, res) => {
    const format = String(req.query.format || 'rekap_harian');
    assertFormat(format);

    const result = await reports.exportExcel(format, {
      from: toDate(req.query.from) || startOfMonth(),
      to: toDate(req.query.to) || today(),
      month: req.query.month,
      department_id: req.query.department_id,
      employee_id: req.query.employee_id,
      device_id: req.query.device_id,
      status: req.query.status,
    });

    const buffer = Buffer.from(result.buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  })
);

/** Unduh laporan sebagai CSV. */
router.get(
  '/export/csv',
  auth.requirePermission('reports:export'),
  wrap(async (req, res) => {
    const format = String(req.query.format || 'rekap_harian');
    assertFormat(format);

    const result = await reports.exportCsv(format, {
      from: toDate(req.query.from) || startOfMonth(),
      to: toDate(req.query.to) || today(),
      month: req.query.month,
      department_id: req.query.department_id,
      employee_id: req.query.employee_id,
      device_id: req.query.device_id,
      status: req.query.status,
    });

    const buffer = Buffer.from(result.buffer);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  })
);

module.exports = router;
