const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomServiceClient } = require('livekit-server-sdk');
const { createLivekit } = require('../lib/livekit');

const LIVE = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
// dotenv only loads in server.js, so server/.env is invisible here on purpose:
// these run only when someone deliberately exports the env on the command line.
const skip = LIVE ? false : 'LiveKit env not set — run `npm run livekit`, then re-run with LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET exported';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

// deleteRoom isn't on the createLivekit surface (Task 2 left it out on purpose —
// it's Phase 4 scope), so cleanup here talks to the real SDK client directly.
const rooms = LIVE ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) : null;

let n = 0;
// pid-scoped names so a crashed run can't collide with or poison the next one.
const nextRoomName = () => `live-test-${process.pid}-${++n}`;

test('ensureRoom creates a real room with the cap and empty timeout we asked for', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  await livekit.ensureRoom(roomName, 3);

  const [room] = await rooms.listRooms([roomName]);
  assert.equal(room.maxParticipants, 3);
  assert.equal(room.emptyTimeout, 300);
});

test('calling ensureRoom twice for the same meeting is safe', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  // The idempotency question Task 4 depends on: does a second createRoom for
  // the same name resolve, or reject? Observed against a real livekit-server
  // 1.13.7 dev instance: it resolves both times (createRoom is idempotent by
  // room name), so Task 4 needs no catch for an already-exists error. If this
  // assertion ever starts failing against a different server version, that's
  // the answer flipping — change it to assert.rejects with the real error
  // shape instead of forcing doesNotReject to stay green.
  await livekit.ensureRoom(roomName, 3);
  await assert.doesNotReject(() => livekit.ensureRoom(roomName, 3));
});

test('a brand-new room has no participants', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  await livekit.ensureRoom(roomName, 3);

  const participants = await rooms.listParticipants(roomName);
  assert.deepEqual(participants, []);
});

test('a wrong API secret is rejected by the real server', { skip }, async () => {
  // Observed shape (livekit-server 1.13.7): a ServerError with status 401,
  // name "Unauthorized", message "invalid authorization token: token
  // signature is invalid: signature is invalid" — this is what Task 4's
  // 503-mapping path is built against.
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: 'wrong-secret' });
  await assert.rejects(() => livekit.ping(), { status: 401 });
});
