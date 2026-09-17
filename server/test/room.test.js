const test = require('node:test');
const assert = require('node:assert/strict');
const seats = require('../lib/seats');
const { registerRoomHandlers, closeStaleMeetings } = require('../lib/room');
const {
  setupTestDb,
  fakeSocketAuth,
  startSocketServer,
  connectClient,
  waitForEvent,
  insertUser,
  insertMeeting,
} = require('./helpers');

// setupTestDb truncates every table and node:test runs these sequentially, so one
// id is enough. t.after clears the in-memory seat state to match.
const MEETING_ID = 'abc-defg-hij';

// maxParticipants = 3 everywhere, matching the spec's acceptance list:
// the host plus 2 others.
async function scenario(db, { admission = 'auto', maxParticipants = 3 } = {}) {
  const meetingId = MEETING_ID;
  await insertUser(db, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  await insertUser(db, { id: 'p1', email: 'p1@zylo.test', name: 'Priya One' });
  await insertUser(db, { id: 'p2', email: 'p2@zylo.test', name: 'Pablo Two' });
  await insertUser(db, { id: 'p3', email: 'p3@zylo.test', name: 'Pia Three' });
  await insertMeeting(db, { id: meetingId, hostId: 'host', admission, maxParticipants });

  const server = await startSocketServer((io) => {
    io.use(fakeSocketAuth);
    registerRoomHandlers(io, { db, graceMs: 60 });
  });
  return { meetingId, server };
}

test('auto mode: two people race for the last seat, exactly one is admitted', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  // Host takes the reserved seat, p1 takes the one participant seat.
  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }

  // p2 and p3 request together; max is 3, so only one more fits.
  const c2 = connectClient(server.url, 'p2');
  const c3 = connectClient(server.url, 'p3');
  clients.push(c2, c3);
  await Promise.all([waitForEvent(c2, 'connect'), waitForEvent(c3, 'connect')]);

  const settled = (c) =>
    Promise.race([
      waitForEvent(c, 'meeting:admitted').then(() => ({ admitted: true })),
      waitForEvent(c, 'meeting:waiting').then((payload) => ({ admitted: false, payload })),
    ]);
  const results = Promise.all([settled(c2), settled(c3)]);
  c2.emit('meeting:join-request', { meetingId });
  c3.emit('meeting:join-request', { meetingId });
  const [r2, r3] = await results;

  assert.equal([r2.admitted, r3.admitted].filter(Boolean).length, 1);
  const waiting = r2.admitted ? r3 : r2;
  assert.deepEqual(waiting.payload, { position: 1, manual: false });
});

test('auto mode: an explicit leave admits the waiting user', async (t) => {
  const db = await setupTestDb();
  // maxParticipants: 2 here (not the default 3) — host + p1 must fill the
  // room's one non-host slot completely, so p2's solo request actually queues
  // instead of finding a second slot still free.
  const { meetingId, server } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, hostP1] = clients;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await waiting, { position: 1, manual: false });

  const admitted = waitForEvent(c2, 'meeting:admitted');
  const presence = waitForEvent(c2, 'room:presence');
  hostP1.emit('meeting:leave');
  await admitted;
  const { people } = await presence;
  assert.deepEqual(people.map((p) => p.userId).sort(), ['host', 'p2']);
  assert.equal(people.find((p) => p.userId === 'host').isHost, true);
  assert.equal(people.find((p) => p.userId === 'p2').name, 'Pablo Two');
});

test('a dropped connection keeps the seat for the grace period, then frees it', async (t) => {
  const db = await setupTestDb();
  // Same reasoning as the previous test: max 2 so host + p1 fill the one
  // non-host slot, making p2's solo request queue instead of being admitted.
  const { meetingId, server } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  await waiting;

  p1.disconnect();
  // graceMs is 60 in these tests; the seat must still be held well inside it.
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(seats.hasSeat(meetingId, 'p1'), true);

  await waitForEvent(c2, 'meeting:admitted');
  assert.equal(seats.hasSeat(meetingId, 'p1'), false);
});

test('a second tab takes the seat over and the first tab is told', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const first = connectClient(server.url, 'p1');
  clients.push(first);
  const firstAdmitted = waitForEvent(first, 'meeting:admitted');
  first.emit('meeting:join-request', { meetingId });
  await firstAdmitted;

  const second = connectClient(server.url, 'p1');
  clients.push(second);
  const replaced = waitForEvent(first, 'meeting:replaced');
  const secondAdmitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, secondAdmitted]);

  assert.equal(seats.listSeats(meetingId).length, 1);

  // The replaced tab must not be able to release the new tab's seat.
  first.disconnect();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seats.hasSeat(meetingId, 'p1'), true);
});

test('a request for an unknown meeting is denied', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const c = connectClient(server.url, 'p1');
  clients.push(c);
  const denied = waitForEvent(c, 'meeting:denied');
  c.emit('meeting:join-request', { meetingId: 'zzz-zzzz-zzz' });
  assert.deepEqual(await denied, { reason: 'not_found' });
});

test('a removed user cannot rejoin', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  await db.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, role, removed_at)
     VALUES ($1, 'p1', 'participant', now())`,
    [meetingId],
  );
  const c = connectClient(server.url, 'p1');
  clients.push(c);
  const denied = waitForEvent(c, 'meeting:denied');
  c.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'removed' });
});

test('a stale tab dropping out of the queue does not evict a newer tab for the same user', async (t) => {
  const db = await setupTestDb();
  // max 2 so host + p1 fill the room's one non-host slot, putting p2 in the queue.
  const { meetingId, server } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;

  // p2 opens tab A and queues, then opens tab B for the same account while still
  // queued — enqueue() refreshes the one queue entry in place, so it now points
  // at tab B's socket even though tab A is still connected.
  const tabA = connectClient(server.url, 'p2');
  clients.push(tabA);
  const waitingA = waitForEvent(tabA, 'meeting:waiting');
  tabA.emit('meeting:join-request', { meetingId });
  await waitingA;

  const tabB = connectClient(server.url, 'p2');
  clients.push(tabB);
  const waitingB = waitForEvent(tabB, 'meeting:waiting');
  tabB.emit('meeting:join-request', { meetingId });
  await waitingB;

  // Tab A's now-stale connection drops (a network blip finally timing out).
  // It must not evict tab B's queue entry.
  tabA.disconnect();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seats.queuedEntries(meetingId).length, 1);
  assert.equal(seats.queueSocketId(meetingId, 'p2'), tabB.id);

  // When a seat frees, tab B — not the dropped tab A — is the one admitted.
  const admittedB = waitForEvent(tabB, 'meeting:admitted');
  p1.emit('meeting:leave');
  await admittedB;
});
