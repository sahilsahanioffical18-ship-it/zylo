const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TokenVerifier } = require('livekit-server-sdk');
const { createLivekit } = require('../lib/livekit');

const API_KEY = 'devkey';
const API_SECRET = 'secret';

// dotenv is never loaded in tests (see server.js) — save/restore so a real
// developer .env sitting in process.env from some other tool can't leak in.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const noEnv = { LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined };

test('createLivekit returns null when any LiveKit setting is missing', () =>
  withEnv(noEnv, async () => {
    assert.equal(createLivekit({ url: '', apiKey: API_KEY, apiSecret: API_SECRET }), null);
    assert.equal(createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: undefined, apiSecret: API_SECRET }), null);
    assert.equal(createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: undefined }), null);
    assert.notEqual(
      createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} }),
      null,
    );
  }));

test('mintToken grants exactly what the spec allows, and nothing more', async () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  const jwt = await livekit.mintToken({ meetingId: 'meeting-1', userId: 'user-1', name: 'Ada' });

  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(jwt);
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.name, 'Ada');
  assert.equal(claims.video.room, 'meeting-1');
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublish, true);
  assert.deepEqual(claims.video.canPublishSources, ['camera', 'microphone']);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.equal(claims.video.roomCreate, undefined);
});

test('mintToken issues a 10-minute token', async () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  const jwt = await livekit.mintToken({ meetingId: 'meeting-1', userId: 'user-1', name: 'Ada' });

  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(jwt);
  assert.equal(claims.exp - claims.nbf, 600);
});

test('the browser url comes back untouched', () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  assert.equal(livekit.url, 'ws://127.0.0.1:7880');
});

test("ensureRoom creates the room with the meeting's cap and a 5-minute empty timeout", async () => {
  let received;
  const rooms = {
    createRoom: async (options) => {
      received = options;
    },
  };
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms });

  await livekit.ensureRoom('meeting-1', 7);

  assert.deepEqual(received, { name: 'meeting-1', maxParticipants: 7, emptyTimeout: 300 });
});

test('ensureRoom propagates an upstream failure to its caller', async () => {
  const rooms = {
    createRoom: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:7880');
    },
  };
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms });

  await assert.rejects(() => livekit.ensureRoom('meeting-1', 7));
});

test('ping rejects when LiveKit does not answer', async () => {
  const down = createLivekit({
    url: 'ws://127.0.0.1:7880',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    rooms: {
      listRooms: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:7880');
      },
    },
  });
  await assert.rejects(() => down.ping());

  const up = createLivekit({
    url: 'ws://127.0.0.1:7880',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    rooms: { listRooms: async () => [] },
  });
  await assert.doesNotReject(() => up.ping());
});
