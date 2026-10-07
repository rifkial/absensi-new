'use strict';

const express = require('express');
const fs = require('node:fs');
const multer = require('multer');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const backup = require('../services/backup');
const audit = require('../services/audit');

const router = express.Router();

router.use(auth.requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

/** Status + daftar file backup (admin saja). */
router.get(
  '/',
  auth.requirePermission('backup:manage'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: { ...backup.status(), files: backup.listBackups() } });
  })
);

/** Buat backup baru: simpan di server + langsung unduh. */
router.post(
  '/',
  auth.requirePermission('backup:manage'),
  wrap(async (req, res) => {
    const result = await backup.createBackup();
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'backup.create',
      entity: 'database',
      detail: { file: result.file, size: result.size, tables: result.tables.length },
    });
    res.json({ ok: true, data: result });
  })
);

/** Unduh file backup dari server. */
router.get(
  '/download/:name',
  auth.requirePermission('backup:manage'),
  wrap(async (req, res) => {
    const full = backup.backupPath(safeName(req.params.name));
    if (!fs.existsSync(full)) throw badRequest('File backup tidak ditemukan.');
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName(req.params.name)}.sql"`);
    res.sendFile(full);
  })
);

/** Hapus file backup di server (data DB tidak ikut terhapus). */
router.delete(
  '/:name',
  auth.requirePermission('backup:manage'),
  wrap(async (req, res) => {
    const full = backup.backupPath(safeName(req.params.name));
    if (!fs.existsSync(full)) throw badRequest('File backup tidak ditemukan.');
    if (/^pre-restore-/.test(safeName(req.params.name))) {
      throw badRequest('Backup pra-restore dilindungi, tidak boleh dihapus dari UI.');
    }
    fs.unlinkSync(full);
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'backup.delete',
      entity: 'database',
      detail: { file: `${safeName(req.params.name)}.sql` },
    });
    res.json({ ok: true, data: { deleted: true } });
  })
);

/** Upload file .sql ke folder backup server (tanpa restore). */
router.post(
  '/upload',
  auth.requirePermission('backup:manage'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw badRequest('File tidak ditemukan. Gunakan field "file".');
    const text = req.file.buffer.toString('utf8');
    backup.assertBackupSql(text);
    const base = safeName((req.file.originalname || 'upload.sql').replace(/\.sql$/i, '')) || `upload-${Date.now()}`;
    const target = backup.backupPath(`${base}-upload`);
    fs.writeFileSync(target, text, 'utf8');
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'backup.upload',
      entity: 'database',
      detail: { file: `${base}-upload.sql`, size: req.file.buffer.length },
    });
    res.json({ ok: true, data: { file: `${base}-upload.sql`, size: req.file.buffer.length } });
  })
);

/**
 * Restore: dari file di server atau upload langsung.
 * Wajib body.confirm = nama database persis (anti salah klik).
 */
router.post(
  '/restore',
  auth.requirePermission('backup:manage'),
  upload.single('file'),
  wrap(async (req, res) => {
    let sql = null;
    let source = null;
    if (req.file) {
      sql = req.file.buffer.toString('utf8');
      source = `upload:${req.file.originalname || 'file.sql'}`;
    } else if (req.body?.name) {
      const full = backup.backupPath(safeName(req.body.name));
      if (!fs.existsSync(full)) throw badRequest('File backup tidak ditemukan.');
      sql = fs.readFileSync(full, 'utf8');
      source = `server:${safeName(req.body.name)}.sql`;
    } else {
      throw badRequest('Sertakan file upload (field "file") atau nama file server (body.name).');
    }

    const result = await backup.restoreFromSql(sql, { confirm: req.body?.confirm, actor: req.user.id });
    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'backup.restore',
      entity: 'database',
      detail: { source, preBackup: result.preBackup, executed: result.executed },
    });
    res.json({ ok: true, data: { source, ...result } });
  })
);

module.exports = router;
