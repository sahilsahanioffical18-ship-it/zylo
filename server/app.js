const express = require('express');
const cors = require('cors');

function createApp({ db, auth }) {
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000' }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    let dbOk = false;
    if (db) {
      try {
        await db.query('SELECT 1');
        dbOk = true;
      } catch {
        dbOk = false;
      }
    }
    res.json({ ok: true, db: dbOk });
  });

  app.use('/api', (_req, res, next) => {
    if (!db) return res.status(503).json({ error: 'Database is not configured on the server (DATABASE_URL).' });
    next();
  });
  app.use('/api', auth);

  // API routers are mounted here (Task 5).

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
