const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRedis } = require('../lib/redis');
const { setupTestDb, seedMeeting, startRoomServer, connectClient, waitForEvent, quietLog } = require('./helpers');

test('with Redis unreachable, a join is refused as unavailable and never admitted', async (t) => {
  t.mock.method(console, 'error', () => {}); // the failure this test makes on purpose
  const db = await setupTestDb();
  const deadRedis = createRedis('redis://127.0.0.1:6390', { log: quietLog }); // nothing listens here
  const meetingId = await seedMeeting(db);
  const room = await startRoomServer(db, deadRedis);
  const client = connectClient(room.url, 'host');
  t.after(async () => {
    client.disconnect();
    await room.close();
    deadRedis.disconnect();
    await db.close();
  });
  const admitted = [];
  client.on('meeting:admitted', () => admitted.push(true));
  const denied = waitForEvent(client, 'meeting:denied');
  client.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'unavailable' });
  assert.deepEqual(admitted, []);
  assert.match(console.error.mock.calls[0].arguments[0], /join failed/);
});
