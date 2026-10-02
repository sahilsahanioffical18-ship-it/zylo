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
