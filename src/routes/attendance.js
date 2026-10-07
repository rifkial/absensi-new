'use strict';

const express = require('express');

const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const { badRequest } = require('../utils/errors');
const attendance = require('../services/attendance');
const portal = require('../services/employeePortal');
const audit = require('../services/audit');
const notify = require('../services/notify');
const employees = require('../services/employees');
const db = require('../db/pool');
const { today, toDate, toDateTime, addDays } = require('../utils/date');

const router = express.Router();

router.use(auth.requireAuth);

/** Statistik untuk dashboard. */
router.get(
  '/dashboard',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rangeDays = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const to = toDate(req.query.to) || today();
    const from = addDays(to, -(rangeDays - 1));

    // Serial, bukan paralel: tiap refresh dashboard = 1 koneksi bergantian,
    // pool tidak habis walau banyak tab refresh bareng. Total tetap <100ms
    // karena tiap query kecil (data harian, bukan agregat berat).
    const summary = await attendance.summary({ from, to });
    const employeeStats = await employees.stats();
    const deviceStats = await db.queryAll(
      `SELECT id, name, protocol, is_active, last_sync_at, last_sync_status, last_sync_message
         FROM devices ORDER BY name`
    );
    const todayData = from === to ? summary : await attendance.summary({ from: to, to });
    const recentLogs = await db.queryAll(
      `SELECT l.id, l.log_time, l.log_state, l.verify_mode, e.name AS employee_name,
              e.employee_code, e.device_user_id, d.name AS device_name
         FROM attendance_logs l
         LEFT JOIN employees e ON e.id = l.employee_id
         LEFT JOIN devices d ON d.id = l.device_id
        ORDER BY l.id DESC
        LIMIT 12`
    );

    res.json({
      ok: true,
      data: {
        range: { from, to, days: rangeDays },
        summary,
        today: todayData,
        trend: (summary.per_day || []).map((d) => ({
          date: d.work_date,
          label: String(d.work_date).slice(8, 10),
          values: {
            hadir: Number(d.hadir || 0),
            telat: Number(d.telat || 0),
            dinas_luar: Number(d.dinas_luar || 0),
            dinas_dalam: Number(d.dinas_dalam || 0),
            izin: Number(d.izin || 0),
            sakit: Number(d.sakit || 0),
            cuti: Number(d.cuti || 0),
            alpa: Number(d.alpa || 0),
            belum: Number(d.belum || 0),
          },
        })),
        employees: employeeStats,
        devices: deviceStats,
        notify: await notify.status(),
        recent_logs: recentLogs.map((l) => ({
          ...l,
          log_state_label: attendance.LOG_STATE[Number(l.log_state)] || l.log_state,
          verify_mode_label: attendance.VERIFY_MODE[Number(l.verify_mode)] || l.verify_mode,
        })),
      },
    });
  })
);

/** Tabel rekap harian dengan filter. */
router.get(
  '/daily',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const from = toDate(req.query.from) || today();
    const to = toDate(req.query.to) || from;
    const result = await attendance.list({ ...req.query, from, to });
    res.json({ ok: true, ...result });
  })
);

/** Papan absensi satu tanggal (default hari ini). */
router.get(
  '/board',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const date = toDate(req.query.date) || today();
    const result = await attendance.list({
      from: date,
      to: date,
      department_id: req.query.department_id,
      per_page: 500,
    });
    res.json({ ok: true, date, ...result });
  })
);

/** Ringkasan status untuk rentang tanggal. */
router.get(
  '/summary',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const from = toDate(req.query.from) || today();
    const to = toDate(req.query.to) || from;
    res.json({ ok: true, data: await attendance.summary({ from, to, departmentId: req.query.department_id }) });
  })
);

/** Detail satu karyawan pada satu tanggal, termasuk log mentahnya. */
router.get(
  '/detail/:employeeId/:date',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const date = toDate(req.params.date) || today();
    const result = await attendance.getOne(Number(req.params.employeeId), date);
    res.json({ ok: true, date, ...result });
  })
);

/** Foto selfie dinas (check-in/out) untuk admin/HR/operator. */
async function serveDutySelfie(req, res, kind) {
  const duty = await db.queryOne('SELECT id, employee_id FROM duty_checkins WHERE id = ?', [
    Number(req.params.id),
  ]);
  if (!duty) return res.status(404).json({ ok: false, error: { message: 'Data dinas tidak ditemukan.' } });
  const file = await portal.getSelfieFile(duty.employee_id, duty.id, kind);
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.sendFile(file.absolute);
}

router.get(
  '/duty/:id/selfie',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    await serveDutySelfie(req, res, 'in');
  })
);

router.get(
  '/duty/:id/selfie-out',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    await serveDutySelfie(req, res, 'out');
  })
);

/** Log mentah dari mesin. */
router.get(
  '/logs',
  auth.requirePermission('attendance:read'),
  wrap(async (req, res) => {
    const rows = await attendance.rawLogs({
      from: toDate(req.query.from),
      to: toDate(req.query.to),
      employeeId: req.query.employee_id,
      deviceId: req.query.device_id,
      limit: req.query.limit || 300,
      offset: req.query.offset || 0,
    });
    res.json({
      ok: true,
      data: rows.map((l) => ({
        ...l,
        log_state_label: attendance.LOG_STATE[Number(l.log_state)] || l.log_state,
        verify_mode_label: attendance.VERIFY_MODE[Number(l.verify_mode)] || l.verify_mode,
      })),
    });
  })
);

/** Buat / perbarui rekap. */
router.post(
  '/generate',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const from = toDate(req.body?.from) || today();
    const to = toDate(req.body?.to) || from;

    const result = await attendance.generate({
      from,
      to,
      employeeId: req.body?.employee_id ? Number(req.body.employee_id) : null,
      departmentId: req.body?.department_id ? Number(req.body.department_id) : null,
    });

    res.json({ ok: true, data: result });
  })
);

/** Kembalikan rekap N hari terakhir (dipakai setelah sync). */
router.post(
  '/backfill',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
    const result = await attendance.backfill(days);
    res.json({ ok: true, data: result });
  })
);

/** Koreksi manual satu baris rekap. */
router.put(
  '/override/:employeeId/:date',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const date = toDate(req.params.date);
    if (!date) throw badRequest('Tanggal tidak valid.');
    const employeeId = Number(req.params.employeeId);

    // Simpan kondisi lama supaya jejak audit menunjukkan angka sebelum/sesudah.
    const before = await db.queryOne(
      `SELECT status, first_in, first_out, late_minutes, work_minutes,
              overtime_minutes, scan_count, note, is_auto
         FROM attendance_daily
        WHERE employee_id = ? AND work_date = ?`,
      [employeeId, date]
    );

    const result = await attendance.override(employeeId, date, {
      status: req.body?.status,
      note: req.body?.note,
      isAuto: false,
    });

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'attendance.override',
      entity: 'attendance_daily',
      entityId: `${employeeId}:${date}`,
      before,
      after: result?.daily || null,
      detail: { alasan: req.body?.note || null },
    });

    res.json({ ok: true, ...result });
  })
);

/** Rekap ulang khusus satu karyawan (agar koreksi manual tidak tertimpa diam-diam). */
router.delete(
  '/override/:employeeId/:date',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const date = toDate(req.params.date);
    if (!date) throw badRequest('Tanggal tidak valid.');
    const employeeId = Number(req.params.employeeId);

    const before = await db.queryOne(
      'SELECT status, note, is_auto FROM attendance_daily WHERE employee_id = ? AND work_date = ?',
      [employeeId, date]
    );

    await db.execute(
      'UPDATE attendance_daily SET is_auto = 1, note = NULL WHERE employee_id = ? AND work_date = ?',
      [employeeId, date]
    );
    const result = await attendance.generateForEmployee(employeeId, date);

    await audit.recordChange({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'attendance.override_reset',
      entity: 'attendance_daily',
      entityId: `${employeeId}:${date}`,
      before,
      after: { note: null, is_auto: 1 },
    });

    res.json({ ok: true, message: 'Koreksi manual dibatalkan, rekap dihitung ulang dari log mesin.', data: result });
  })
);

/** Tambah log manual (mis. karyawan lupa scan, ada bukti). */
router.post(
  '/manual-log',
  auth.requirePermission('attendance:write'),
  wrap(async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) throw badRequest('employee_id wajib diisi.');

    const employee = await employees.getOrFail(employeeId);
    const logTime = toDateTime(req.body?.log_time);
    if (!logTime) throw badRequest('log_time tidak valid. Format: YYYY-MM-DD HH:mm[:ss]');

    const logDate = logTime.slice(0, 10);
    const logState = Number.isInteger(Number(req.body?.log_state)) ? Number(req.body.log_state) : 0;
    const verifyMode = Number.isInteger(Number(req.body?.verify_mode)) ? Number(req.body.verify_mode) : 2;
    const workCode = String(req.body?.work_code || 'MANUAL');

    const result = await db.execute(
      `INSERT INTO attendance_logs
         (device_id, employee_id, device_user_id, log_time, log_date, log_state, verify_mode, work_code, source)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'manual')
       ON DUPLICATE KEY UPDATE log_state = VALUES(log_state), log_time = VALUES(log_time)`,
      [employeeId, employee.device_user_id || String(employeeId), logTime, logDate, logState, verifyMode, workCode]
    );

    await attendance.generateForEmployee(employeeId, logDate);

    await audit.record({
      userId: req.user.id,
      ip: audit.ipOf(req),
      action: 'attendance.manual_log',
      entity: 'attendance_logs',
      entityId: employeeId,
      detail: {
        employee: `${employee.employee_code} - ${employee.name}`,
        log_time: logTime,
        log_state: logState,
        verify_mode: verifyMode,
        work_code: workCode,
      },
    });

    res.json({
      ok: true,
      inserted: result.affectedRows > 0,
      message: 'Log manual tersimpan dan rekap diperbarui.',
    });
  })
);

// ---------------------------------------------------------------------------
// Notifikasi
// ---------------------------------------------------------------------------

router.get(
  '/notify/status',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    res.json({ ok: true, data: await notify.status() });
  })
);

router.post(
  '/notify/daily',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const employeeId = Number(req.body?.employee_id);
    if (!employeeId) throw badRequest('employee_id wajib diisi.');

    const employee = await employees.getOrFail(employeeId);
    const result = await notify.notifyDaily(employee, toDate(req.body?.date) || today());

    res.json({ ok: result.ok !== false, data: result });
  })
);

router.post(
  '/notify/late',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const result = await notify.notifyLateEmployees(toDate(req.body?.date) || today(), req.body?.department_id);
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/notify/monthly-report',
  auth.requirePermission('notify:send'),
  wrap(async (req, res) => {
    const month = String(req.body?.month || today().slice(0, 7));
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month harus format YYYY-MM.');

    const result = await notify.sendMonthlyReport({
      month,
      to: { email: req.body?.email, whatsapp: req.body?.whatsapp },
    });

    res.json({ ok: true, data: result });
  })
);

module.exports = router;
