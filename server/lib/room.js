const seats = require('./seats');

const roomChannel = (meetingId) => `meeting:${meetingId}`;

function registerRoomHandlers(io, { db, graceMs = seats.GRACE_MS } = {}) {
  // Settings for every meeting that is currently live, so the host check and the
  // seat cap never wait on the DB inside a seat-grab path.
  const liveMeetings = new Map();

  async function loadMeetingMeta(meetingId) {
    const cached = liveMeetings.get(meetingId);
    if (cached) return cached;
    const { rows } = await db.query(
      `SELECT host_id, admission, screen_share_policy, max_participants, ended_at
       FROM meetings WHERE id = $1`,
      [meetingId],
    );
    if (rows.length === 0) return null;
    if (rows[0].ended_at) return { ended: true }; // never cached: it is over
    const meta = {
      hostId: rows[0].host_id,
      admission: rows[0].admission,
      screenSharePolicy: rows[0].screen_share_policy,
      maxParticipants: rows[0].max_participants,
    };
    liveMeetings.set(meetingId, meta);
    return meta;
  }

  async function isRemoved(meetingId, userId) {
    const { rows } = await db.query(
      'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
      [meetingId, userId],
    );
    return rows.length > 0 && rows[0].removed_at !== null;
  }

  async function userInfo(userId) {
    const { rows } = await db.query('SELECT name, image_url FROM users WHERE id = $1', [userId]);
    return { name: rows[0]?.name ?? 'Someone', imageUrl: rows[0]?.image_url ?? null };
  }

  const markStarted = (meetingId) =>
    db.query('UPDATE meetings SET started_at = COALESCE(started_at, now()) WHERE id = $1', [meetingId]);

  // Only a meeting that actually started can end, so a lobby that empties out
  // before anyone was admitted never gets a bogus ended_at.
  const markEnded = (meetingId) =>
    db.query(
      'UPDATE meetings SET ended_at = now() WHERE id = $1 AND started_at IS NOT NULL AND ended_at IS NULL',
      [meetingId],
    );

  const upsertParticipant = (meetingId, userId, isHostUser) =>
    db.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meetingId, userId, isHostUser ? 'host' : 'participant'],
    );

  function broadcastPresence(meetingId) {
    io.to(roomChannel(meetingId)).emit('room:presence', {
      people: seats
        .listSeats(meetingId)
        .map(({ userId, name, imageUrl, isHost }) => ({ userId, name, imageUrl, isHost })),
    });
  }

  // One call refreshes both sides of the lobby: the host's list, and every waiting
  // person's position (the spec promises everyone a new position when the queue
  // moves). Callers only ever have to remember this one function.
  function broadcastLobby(meetingId) {
    const meta = liveMeetings.get(meetingId);
    const waiting = seats.queuedEntries(meetingId);
    const host = seats.listSeats(meetingId).find((seat) => seat.isHost);
    const hostSocket = host ? io.sockets.sockets.get(host.socketId) : null;
    if (hostSocket) {
      hostSocket.emit('lobby:update', {
        waiting: waiting.map(({ userId, name, imageUrl }) => ({ userId, name, imageUrl })),
      });
    }
    waiting.forEach((entry, index) => {
      io.sockets.sockets
        .get(entry.socketId)
        ?.emit('meeting:waiting', { position: index + 1, manual: meta?.admission === 'manual' });
    });
  }

  // Presence and lobby are NOT broadcast here: callers admitting several people at
  // once broadcast one time at the end instead of once per person.
  async function admit(socket, meetingId, isHostUser, result) {
    await upsertParticipant(meetingId, socket.data.userId, isHostUser);
    await markStarted(meetingId);
    if (result.replacedSocketId) {
      const old = io.sockets.sockets.get(result.replacedSocketId);
      if (old) {
        old.data.meetingId = null;
        old.leave(roomChannel(meetingId));
        old.emit('meeting:replaced');
      }
    }
    socket.data.meetingId = meetingId;
    socket.join(roomChannel(meetingId));
    socket.emit('meeting:admitted');
  }

  // drainQueue already took the seat; this only runs the admission side effects.
  async function admitDrained(entry, meetingId) {
    const socket = io.sockets.sockets.get(entry.socketId);
    if (!socket) {
      // Their tab is gone: hand the seat straight back rather than leak it.
      seats.releaseSeat(meetingId, entry.userId, { immediate: true });
      return;
    }
    await admit(socket, meetingId, false, { replacedSocketId: null });
  }

  async function onSeatFreed(meetingId) {
    const meta = liveMeetings.get(meetingId);
    if (!meta) return;
    if (meta.admission === 'auto') {
      for (const entry of seats.drainQueue(meetingId, meta.maxParticipants)) {
        await admitDrained(entry, meetingId);
      }
    }
    broadcastPresence(meetingId);
    broadcastLobby(meetingId);
    if (seats.listSeats(meetingId).length > 0) return;
    // Nobody is seated any more, so the meeting is over. Anyone still in the
    // lobby is told rather than left spinning.
    for (const entry of seats.queuedEntries(meetingId)) {
      io.sockets.sockets.get(entry.socketId)?.emit('meeting:denied', { reason: 'ended' });
    }
    await markEnded(meetingId);
    seats.clearMeeting(meetingId);
    liveMeetings.delete(meetingId);
  }

  // Socket.IO does not catch rejections from async handlers, and one unhandled
  // rejection would take the process down. One wrapper covers every handler.
  const on = (socket, event, handler) =>
    socket.on(event, (...args) =>
      Promise.resolve()
        .then(() => handler(...args))
        .catch((err) => console.error(`socket ${event} failed:`, err.message)),
    );

  io.on('connection', (socket) => {
    on(socket, 'meeting:join-request', async ({ meetingId } = {}) => {
      if (typeof meetingId !== 'string') return socket.emit('meeting:denied', { reason: 'not_found' });
      const meta = await loadMeetingMeta(meetingId);
      if (!meta) return socket.emit('meeting:denied', { reason: 'not_found' });
      if (meta.ended) return socket.emit('meeting:denied', { reason: 'ended' });

      const { userId } = socket.data;
      if (await isRemoved(meetingId, userId)) return socket.emit('meeting:denied', { reason: 'removed' });

      const isHostUser = meta.hostId === userId;
      const { name, imageUrl } = await userInfo(userId);
      const entry = { userId, socketId: socket.id, name, imageUrl };

      // Every DB read is done. From here down nothing awaits until the seat is
      // written, which is what makes the last-seat race safe.
      // Someone who already holds a seat is reconnecting, so they skip the lobby.
      if (meta.admission === 'manual' && !isHostUser && !seats.hasSeat(meetingId, userId)) {
        seats.enqueue(meetingId, entry);
        socket.data.meetingId = meetingId;
        return broadcastLobby(meetingId);
      }
      const result = seats.tryTakeSeat(meetingId, {
        ...entry,
        isHost: isHostUser,
        max: meta.maxParticipants,
      });
      if (!result.ok) {
        seats.enqueue(meetingId, entry);
        socket.data.meetingId = meetingId;
        return broadcastLobby(meetingId);
      }
      await admit(socket, meetingId, isHostUser, result);
      broadcastPresence(meetingId);
      // A host arriving needs to see whoever is already waiting for them.
      if (isHostUser) broadcastLobby(meetingId);
    });

    on(socket, 'meeting:leave', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return socket.disconnect(true);
      seats.removeFromQueue(meetingId, userId);
      seats.releaseSeat(meetingId, userId, { immediate: true });
      socket.leave(roomChannel(meetingId));
      socket.data.meetingId = null;
      await onSeatFreed(meetingId);
      socket.disconnect(true);
    });

    on(socket, 'disconnect', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      // A newer connection may already hold this queue entry (two tabs). Never
      // pull it out from under them.
      if (seats.queueSocketId(meetingId, userId) === socket.id && seats.removeFromQueue(meetingId, userId)) {
        broadcastLobby(meetingId);
      }
      // Same guard for the seat itself.
      if (seats.seatSocketId(meetingId, userId) !== socket.id) return;
      seats.releaseSeat(meetingId, userId, {
        graceMs,
        onExpire: () => {
          onSeatFreed(meetingId).catch((err) => console.error('seat release failed:', err.message));
        },
      });
    });
  });
}

module.exports = { registerRoomHandlers, roomChannel };
