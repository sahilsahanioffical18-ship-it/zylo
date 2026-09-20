const express = require('express');
const cors = require('cors');
const { meetingsRouter } = require('./lib/meetings');

// Both probes mean "can we actually reach it", not "is it configured" — a
// health endpoint that calls a configured-but-dead dependency healthy is a lie
// that costs an operator an hour.
// ponytail: neither probe has a timeout, matching the existing SELECT 1. If a
// wedged dependency ever hangs the probe, wrap both in
// Promise.race([p, AbortSignal.timeout(1000)]).
async function reachable(probe) {
  if (!probe) return false;
  try { await probe(); return true; } catch { return false; }
}

function createApp({ db, auth, livekit }) {
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000' }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    const [dbOk, livekitOk] = await Promise.all([
      reachable(db ? () => db.query('SELECT 1') : null),
      reachable(livekit ? () => livekit.ping() : null),
    ]);
    res.json({ ok: true, db: dbOk, livekit: livekitOk });
  });

  app.use('/api', (_req, res, next) => {
    if (!db) return res.status(503).json({ error: 'Database is not configured on the server (DATABASE_URL).' });
    next();
  });
  app.use('/api', auth);

  if (db) app.use('/api', meetingsRouter(db, livekit));

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: status < 500 ? 'That request could not be read.' : 'Something went wrong on the server.',
    });
  });

  return app;
}

module.exports = { createApp };
