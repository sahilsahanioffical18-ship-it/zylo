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

test('manual mode: the host sees the lobby, admits and denies', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now so a later 'lobby:update'
  // listener below can't race and catch this stale one instead.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  const c1 = connectClient(server.url, 'p1');
  clients.push(c1);
  let lobby = waitForEvent(host, 'lobby:update');
  const waiting = waitForEvent(c1, 'meeting:waiting');
  c1.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await waiting, { position: 1, manual: true });
  assert.deepEqual((await lobby).waiting, [{ userId: 'p1', name: 'Priya One', imageUrl: null }]);

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  lobby = waitForEvent(host, 'lobby:update');
  // c2's own join broadcasts its initial position over its own socket, a
  // connection independent of the host's — consume it now so the next
  // 'meeting:waiting' listener below can't race and catch this stale one.
  const c2Waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  assert.deepEqual((await lobby).waiting.map((w) => w.userId), ['p1', 'p2']);
  assert.deepEqual(await c2Waiting, { position: 2, manual: true });

  // Admit p1.
  const admitted = waitForEvent(c1, 'meeting:admitted');
  // p2 moves up to position 1 as the queue shifts.
  const moved = waitForEvent(c2, 'meeting:waiting');
  host.emit('lobby:admit', { userId: 'p1' });
  await admitted;
  assert.deepEqual(await moved, { position: 1, manual: true });

  // Deny p2.
  const denied = waitForEvent(c2, 'meeting:denied');
  lobby = waitForEvent(host, 'lobby:update');
  host.emit('lobby:deny', { userId: 'p2' });
  assert.deepEqual(await denied, { reason: 'denied' });
  assert.deepEqual((await lobby).waiting, []);
});

test('manual mode: admitting into a full ZyloRoom is refused, and they stay in the lobby', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  for (const userId of ['p1', 'p2', 'p3']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const waiting = waitForEvent(c, 'meeting:waiting');
    c.emit('meeting:join-request', { meetingId });
    await waiting;
  }
  const [, c1, c2, c3] = clients;

  for (const [client, userId] of [[c1, 'p1'], [c2, 'p2']]) {
    const admitted = waitForEvent(client, 'meeting:admitted');
    host.emit('lobby:admit', { userId });
    await admitted;
  }

  // max is 3 (host + 2), so the third admit must be refused.
  const ack = await new Promise((resolve) => host.emit('lobby:admit', { userId: 'p3' }, resolve));
  assert.deepEqual(ack, { ok: false, reason: 'full' });
  assert.equal(seats.hasSeat(meetingId, 'p3'), false);
  assert.deepEqual(seats.queuedEntries(meetingId).map((e) => e.userId), ['p3']);
  c3.disconnect();
});

test('a non-host lobby:admit is forbidden', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now so the 'queued' listener
  // below can't race and catch this stale one instead of p1's real one.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  // Wait for p1 to actually reach the lobby before admitting: emitting both back
  // to back would race the host's admit past the join request.
  const c1 = connectClient(server.url, 'p1');
  clients.push(c1);
  const queued = waitForEvent(host, 'lobby:update');
  c1.emit('meeting:join-request', { meetingId });
  await queued;

  const admitted = waitForEvent(c1, 'meeting:admitted');
  host.emit('lobby:admit', { userId: 'p1' });
  await admitted;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  await waiting;

  const forbidden = waitForEvent(c1, 'error:forbidden');
  c1.emit('lobby:admit', { userId: 'p2' });
  await forbidden;
  assert.equal(seats.hasSeat(meetingId, 'p2'), false);

  // A waiting user has a meetingId too, and is just as forbidden.
  const forbiddenAgain = waitForEvent(c2, 'error:forbidden');
  c2.emit('host:set-admission', { mode: 'auto' });
  await forbiddenAgain;
});

test('switching manual to auto drains the lobby in order until seats run out', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now, and drain each loop
  // iteration's lobby update below in lockstep, so the 'lobby:update' listener
  // set up after the loop can't race and catch a stale one of these instead.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  for (const userId of ['p1', 'p2', 'p3']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const waiting = waitForEvent(c, 'meeting:waiting');
    const hostLobby = waitForEvent(host, 'lobby:update');
    c.emit('meeting:join-request', { meetingId });
    await waiting;
    await hostLobby;
  }
  const [, c1, c2, c3] = clients;

  const settings = waitForEvent(host, 'meeting:settings');
  const first = waitForEvent(c1, 'meeting:admitted');
  const second = waitForEvent(c2, 'meeting:admitted');
  const stillWaiting = waitForEvent(c3, 'meeting:waiting');
  const lobby = waitForEvent(host, 'lobby:update');
  host.emit('host:set-admission', { mode: 'auto' });

  assert.deepEqual(await settings, { admission: 'auto', screenSharePolicy: 'anyone' });
  await Promise.all([first, second]);
  assert.deepEqual(await stillWaiting, { position: 1, manual: false });
  assert.deepEqual((await lobby).waiting.map((w) => w.userId), ['p3']);

  const { rows } = await db.query('SELECT admission FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].admission, 'auto');
});

test('everyone leaving ends the meeting in the database', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    seats.clearMeeting(meetingId);
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  const c1 = connectClient(server.url, 'p1');
  clients.push(host, c1);
  for (const c of clients) {
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }

  const gone = waitForEvent(host, 'disconnect');
  c1.emit('meeting:leave');
  await new Promise((r) => setTimeout(r, 50));
  host.emit('meeting:leave');
  await gone;
  await new Promise((r) => setTimeout(r, 50));

  const { rows } = await db.query('SELECT started_at, ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].started_at, null);
  assert.notEqual(rows[0].ended_at, null);

  const participants = await db.query(
    'SELECT user_id, role FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id',
    [meetingId],
  );
  assert.deepEqual(participants.rows, [
    { user_id: 'host', role: 'host' },
    { user_id: 'p1', role: 'participant' },
  ]);
});

test('the boot sweep closes meetings a crash left open', async (t) => {
  const db = await setupTestDb();
  t.after(async () => db.close());

  await insertUser(db, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  await insertMeeting(db, { id: 'sta-lemt-ing', hostId: 'host' });
  await insertMeeting(db, { id: 'fut-uree-eet', hostId: 'host' });
  await db.query("UPDATE meetings SET started_at = now() - interval '2 hours' WHERE id = 'sta-lemt-ing'");

  await closeStaleMeetings(db);

  const { rows } = await db.query('SELECT id, ended_at FROM meetings ORDER BY id');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.ended_at]));
  assert.notEqual(byId['sta-lemt-ing'], null);
  assert.equal(byId['fut-uree-eet'], null); // never started, so never ended
});
