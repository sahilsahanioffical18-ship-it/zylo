const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../lib/db');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const seats = require('../lib/seats');
const { registerRoomHandlers } = require('../lib/room');

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

function insertMeeting(
  db,
  { id, hostId, title = 'ZyloCall', admission = 'auto', screenSharePolicy = 'anyone', maxParticipants = 20 },
) {
  return db.query(
    `INSERT INTO meetings (id, host_id, title, admission, screen_share_policy, max_participants)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, hostId, title, admission, screenSharePolicy, maxParticipants],
  );
}

// The four users and one meeting most socket tests need, and a Socket.IO server
// running the real room handlers. graceMs is short so grace expiry is testable.
async function startRoom(
  db,
  { meetingId = 'abc-defg-hij', admission = 'auto', screenSharePolicy = 'anyone', maxParticipants = 3, graceMs = 60, livekit = null } = {},
) {
  await insertUser(db, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  await insertUser(db, { id: 'p1', email: 'p1@zylo.test', name: 'Priya One' });
  await insertUser(db, { id: 'p2', email: 'p2@zylo.test', name: 'Pablo Two' });
  await insertUser(db, { id: 'p3', email: 'p3@zylo.test', name: 'Pia Three' });
  await insertMeeting(db, { id: meetingId, hostId: 'host', admission, screenSharePolicy, maxParticipants });
  const server = await startSocketServer((io) => {
    io.use(fakeSocketAuth);
    registerRoomHandlers(io, { db, graceMs, livekit });
  });
  return { meetingId, server };
}

// Connects userId and resolves once they hold a seat.
async function seat(url, userId, meetingId) {
  const client = connectClient(url, userId);
  const admitted = waitForEvent(client, 'meeting:admitted');
  client.emit('meeting:join-request', { meetingId });
  await admitted;
  return client;
}

// Every `event` a socket receives. Register before the emit under test, and read
// it after settle(): proving something did NOT arrive needs a window, not a race.
function collect(socket, event) {
  const got = [];
  socket.on(event, (payload) => got.push(payload));
  return got;
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// Stands in for lib/livekit.js: records each enforcement call, touches no network.
function recordingLivekit() {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    callsTo: (name) => calls.filter(([n]) => n === name).map(([, ...args]) => args),
    evict: record('evict'),
    grantScreenShare: record('grantScreenShare'),
    revokeScreenShare: record('revokeScreenShare'),
    muteMic: record('muteMic'),
    endRoom: record('endRoom'),
  };
}

// Takes ZyloLive for `client`, then lets the grant's broadcast settle.
async function shareScreen(client) {
  const granted = waitForEvent(client, 'screen:granted');
  client.emit('screen:request');
  await granted;
  await settle();
}

// One test's whole world — fresh DB, real handlers, recording LiveKit — torn down in t.after.
async function roomHarness(t, options = {}) {
  const db = await setupTestDb();
  const livekit = recordingLivekit();
  const { meetingId, server } = await startRoom(db, { ...options, livekit });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });
  const connect = (userId) => { const c = connectClient(server.url, userId); clients.push(c); return c; };
  const join = async (userId) => { const c = await seat(server.url, userId, meetingId); clients.push(c); return c; };
  return { db, livekit, meetingId, server, connect, join };
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
  startRoom,
  seat,
  collect,
  settle,
  recordingLivekit,
  roomHarness,
  shareScreen,
};
