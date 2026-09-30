const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../lib/roomStore');
const { twoServerHarness, waitForEvent, collect, settle } = require('./helpers');

test('chat sent on one server reaches people on the other', async (t) => {
  const { a, b } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const got = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: 'hello from server A' });
  assert.equal((await got).text, 'hello from server A');
});

test('two joins on different servers race for the last seat: exactly one gets it', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t); // max 3: the host + 2
  await a.join('host');
  await b.join('p1');
  const c2 = a.connect('p2');
  const c3 = b.connect('p3');
  await Promise.all([waitForEvent(c2, 'connect'), waitForEvent(c3, 'connect')]);
  const outcome = (c) =>
    Promise.race([
      waitForEvent(c, 'meeting:admitted').then(() => 'admitted'),
      waitForEvent(c, 'meeting:waiting').then(() => 'waiting'),
    ]);
  const results = Promise.all([outcome(c2), outcome(c3)]);
  c2.emit('meeting:join-request', { meetingId });
  c3.emit('meeting:join-request', { meetingId });
  assert.deepEqual((await results).sort(), ['admitted', 'waiting']);
});

test('a host on one server removes someone on the other', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const removed = waitForEvent(p1, 'meeting:removed');
  host.emit('host:kick', { userId: 'p1' });
  await removed;
  await settle(150);
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('the host admits someone waiting on the other server, who then gets the roster', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t, { admission: 'manual' });
  const host = await a.join('host');
  const waiter = b.connect('p1');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  const admitted = waitForEvent(waiter, 'meeting:admitted');
  const presence = waitForEvent(waiter, 'room:presence');
  const ack = new Promise((resolve) => host.emit('lobby:admit', { userId: 'p1' }, resolve));
  assert.deepEqual(await ack, { ok: true });
  await admitted;
  assert.deepEqual((await presence).people.map((p) => p.userId).sort(), ['host', 'p1']);
});

test('a replaced host tab on the other server keeps no host powers', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const tabA = await a.join('host');
  await a.join('p1');
  const tabB = b.connect('host');
  const admitted = waitForEvent(tabB, 'meeting:admitted');
  tabB.emit('meeting:join-request', { meetingId });
  await admitted;
  const forbidden = collect(tabA, 'error:forbidden');
  tabA.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(forbidden.length, 1);
  assert.equal(livekit.callsTo('muteMic').length, 0);
});

test('dropping off one server and coming back on the other keeps the seat', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t);
  await a.join('host');
  const first = await a.join('p1');
  first.disconnect();
  await settle(20);
  await b.join('p1');
  await settle(150); // past the 60 ms grace server A started
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
});

test("a crashed server's seat is held for the grace period, then freed by the sweep", async (t) => {
  const { a, meetingId, redis } = await twoServerHarness(t);
  const host = await a.join('host');
  // A seat held on a server that died: no heartbeat for it exists.
  const ghost = createRoomStore(redis, { serverId: 'crashed-server' });
  await ghost.join(meetingId, { userId: 'p1', socketId: 'socket-on-a-dead-server', name: 'Priya One', imageUrl: null, lang: null }, { isHost: false });
  const presence = collect(host, 'room:presence');
  await a.handlers.sweep(); // stamps the grace period
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true, 'held while they might come back');
  await settle(100); // graceMs is 60 in tests
  await a.handlers.sweep(); // releases it
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  await settle(50);
  assert.deepEqual(presence.at(-1).people.map((p) => p.userId), ['host']);
});

test("a live server's seats are left alone by the other server's sweep", async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t);
  await a.join('host');
  await b.join('p1');
  await a.handlers.sweep();
  await settle(100);
  await a.handlers.sweep();
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
  assert.equal((await a.store.seatFor(meetingId, 'p1')).graceUntil, undefined);
});

test('a meeting live in Postgres but held by no server is ended by the sweep', async (t) => {
  const { a, db, meetingId } = await twoServerHarness(t);
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [meetingId]);
  await a.handlers.sweep();
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].ended_at, null);
});
