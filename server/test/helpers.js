const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../lib/db');

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Test-only auth: trusts the x-test-user header. Production always uses clerkAuth.
function fakeAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return res.status(401).json({ error: 'Sign in required.' });
  req.userId = userId;
  next();
}

async function setupTestDb() {
  const db = createDb(process.env.TEST_DATABASE_URL || 'postgres://zylo:zylo@localhost:5432/zylo_test');
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await db.query('TRUNCATE meeting_participants, meeting_invites, meetings, users');
  return db;
}

module.exports = { listen, fakeAuth, setupTestDb };
