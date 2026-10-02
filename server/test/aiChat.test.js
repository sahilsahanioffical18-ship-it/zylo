const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roomHarness, collect, settle, waitForEvent } = require('./helpers');

// ── The host's "AI in chat" setting ──────────────────────────────────────────

test('host:set-ai turns AI off and on: saved in the store and Postgres, told to the room', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(p1, 'meeting:settings');

  host.emit('host:set-ai', { enabled: false });
  await settle();
  assert.deepEqual(settings, [{ admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: false }]);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, false);
  const { rows } = await db.query('SELECT ai_enabled FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_enabled, false);

  host.emit('host:set-ai', { enabled: true });
  await settle();
  assert.deepEqual(settings.at(-1), { admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true });
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
});

test('host:set-ai is host-only and ignores anything but a boolean', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(host, 'meeting:settings');
  const forbidden = waitForEvent(p1, 'error:forbidden');
  p1.emit('host:set-ai', { enabled: false });
  await forbidden;
  host.emit('host:set-ai', { enabled: 'false' });
  host.emit('host:set-ai', {});
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
  const { rows } = await db.query('SELECT ai_enabled FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_enabled, true);
});

test('host:set-ai is ignored in a translator convo', async (t) => {
  const { meetingId, store, join } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });
  const host = await join('host');
  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-ai', { enabled: false });
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
});

test('a meeting saved with AI off starts with it off, and every settings broadcast says so', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  await db.query('UPDATE meetings SET ai_enabled = false WHERE id = $1', [meetingId]);
  const host = await join('host');
  assert.equal((await store.getMeta(meetingId)).aiEnabled, false);
  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-admission', { mode: 'manual' });
  await settle();
  host.emit('host:set-screen-policy', { policy: 'host_only' });
  await settle();
  assert.deepEqual(settings, [
    { admission: 'manual', screenSharePolicy: 'anyone', aiEnabled: false },
    { admission: 'manual', screenSharePolicy: 'host_only', aiEnabled: false },
  ]);
});

// ── The chat history the AI reads ────────────────────────────────────────────

test('every chat line joins the history, and a history failure never blocks the chat', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const first = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: '  Agenda: ship date  ' });
  await first;
  await settle(); // the line is added just after it is relayed
  assert.deepEqual(await history.recent(meetingId), [{ name: 'Hana Host', text: 'Agenda: ship date', ai: false }]);

  history.add = async () => {
    throw new Error('redis hiccup');
  };
  const second = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: 'Still delivered' });
  assert.equal((await second).text, 'Still delivered');
  await settle();
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /chat history failed: redis hiccup/.test(line)), logged.join('\n'));
});

test('End for all clears the history', async (t) => {
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  const ended = waitForEvent(host, 'meeting:ended');
  host.emit('host:end-meeting');
  await ended;
  await settle();
  assert.deepEqual(await history.recent(meetingId), []);
});

test('the last person leaving clears the history', async (t) => {
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  const gone = waitForEvent(host, 'disconnect');
  host.emit('meeting:leave');
  await gone;
  await settle();
  assert.deepEqual(await history.recent(meetingId), []);
});

test("the sweep's ends clear the history too", async (t) => {
  const { db, meetingId, history, handlers } = await roomHarness(t);
  // Live in Postgres, held by no server: the sweep's Postgres pass ends it.
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [meetingId]);
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  await handlers.sweep();
  assert.deepEqual(await history.recent(meetingId), []);
});

test("the sweep's idle clear clears the history too", async (t) => {
  // An empty room is "idle" at once, instead of after the real minute.
  const decorateStore = (real) => ({ ...real, clearIfIdle: (code) => real.clearIfIdle(code, 0) });
  const { meetingId, store, history, handlers } = await roomHarness(t, { decorateStore });
  await store.initMeta(meetingId, { hostId: 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard' });
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  await handlers.sweep();
  assert.equal(await store.getMeta(meetingId), null); // the idle clear ran, not some other path
  assert.deepEqual(await history.recent(meetingId), []);
});
