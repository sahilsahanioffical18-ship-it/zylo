const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../lib/db');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

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

// Test-only socket auth: trusts the handshake's userId. Production always uses
// clerkSocketAuth.
function fakeSocketAuth(socket, next) {
  const userId = socket.handshake.auth?.userId;
  if (!userId) return next(new Error('Sign in required.'));
  socket.data.userId = userId;
  next();
}

async function startSocketServer(configureIo) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  configureIo(io);
  httpServer.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    close: () =>
      new Promise((resolve) => {
        io.close();
        httpServer.close(resolve);
      }),
  };
}

function connectClient(url, userId) {
  return ioClient(url, { auth: { userId }, forceNew: true, transports: ['websocket'] });
}

function waitForEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function insertUser(db, { id, email, name, imageUrl = null }) {
  return db.query(
    `INSERT INTO users (id, email, name, image_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, email, name, imageUrl],
  );
}

function insertMeeting(db, { id, hostId, title = 'ZyloCall', admission = 'auto', maxParticipants = 20 }) {
  return db.query(
    `INSERT INTO meetings (id, host_id, title, admission, max_participants) VALUES ($1, $2, $3, $4, $5)`,
    [id, hostId, title, admission, maxParticipants],
  );
}

module.exports = {
  listen,
  fakeAuth,
  setupTestDb,
  fakeSocketAuth,
  startSocketServer,
  connectClient,
  waitForEvent,
  insertUser,
  insertMeeting,
};
