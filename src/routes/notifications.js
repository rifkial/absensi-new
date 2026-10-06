'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const config = require('../config');
const db = require('../db/pool');
const auth = require('../middleware/auth');
const { wrap } = require('../middleware/error');
const realtime = require('../services/realtime');

const router = express.Router();

/** Stream SSE: EventSource tidak bisa kirim header, jadi token via query. */
router.get('/stream', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(401).end();

  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return res.status(401).end();
  }

  const user = await db.queryOne(
    'SELECT id, is_active FROM app_users WHERE id = ?',
    [payload.sub]
  );
  if (!user || !user.is_active) return res.status(401).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  realtime.addClient(user.id, res);
  realtime.sseSend(res, 'ready', { unread: await realtime.unreadCount(user.id) });

  const heartbeat = setInterval(() => {
    try {
      realtime.sseSend(res, 'ping', { t: Date.now() });
    } catch {
      // abaikan, dibersihkan saat close
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    realtime.removeClient(user.id, res);
  });
});

router.use(auth.requireAuth);

router.get(
  '/',
  wrap(async (req, res) => {
    const rows = await realtime.listForUser(req.user.id, {
      limit: req.query.limit,
      unreadOnly: req.query.unread === '1',
    });
    res.json({ ok: true, data: rows, unread: await realtime.unreadCount(req.user.id) });
  })
);

router.get(
  '/unread-count',
  wrap(async (req, res) => {
    res.json({ ok: true, unread: await realtime.unreadCount(req.user.id) });
  })
);

router.post(
  '/read/:id',
  wrap(async (req, res) => {
    res.json({ ok: true, data: await realtime.markRead(req.user.id, req.params.id) });
  })
);

module.exports = router;
