const { AccessToken, RoomServiceClient, TrackSource } = require('livekit-server-sdk');

const TOKEN_TTL = '10m';
const EMPTY_TIMEOUT = 300;

function createLivekit({ url, apiKey, apiSecret, rooms } = {}) {
  url = url ?? process.env.LIVEKIT_URL;
  apiKey = apiKey ?? process.env.LIVEKIT_API_KEY;
  apiSecret = apiSecret ?? process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;

  // RoomServiceClient rewrites ws(s):// to http(s):// internally for its own
  // RPC calls; `url` below stays ws:// as-is because the browser client needs
  // that scheme to connect.
  const roomService = rooms || new RoomServiceClient(url, apiKey, apiSecret);

  return {
    url,
    ping: () => roomService.listRooms([]),
    // No memo: a per-process cache would skip re-creating a room after
    // livekit-server restarts, silently dropping the maxParticipants cap.
    ensureRoom: (meetingId, maxParticipants) =>
      roomService.createRoom({ name: meetingId, maxParticipants, emptyTimeout: EMPTY_TIMEOUT }),
    mintToken: async ({ meetingId, userId, name }) => {
      const token = new AccessToken(apiKey, apiSecret, { identity: userId, name, ttl: TOKEN_TTL });
      token.addGrant({
        roomJoin: true,
        room: meetingId,
        canSubscribe: true,
        canPublish: true,
        canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      });
      return token.toJwt();
    },
  };
}

module.exports = { createLivekit, TOKEN_TTL, EMPTY_TIMEOUT };
