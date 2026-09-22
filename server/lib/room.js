const seats = require('./seats');
const { validateChatText } = require('./chatRules');

const roomChannel = (meetingId) => `meeting:${meetingId}`;

function registerRoomHandlers(io, { db, livekit = null, graceMs = seats.GRACE_MS } = {}) {
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

  // Every seat release in this file goes through here, so none of them can forget
  // LiveKit: the seat is the only thing that authorizes media, so losing it ends the
  // media session too. A token outlives its seat by up to 10 minutes; a reconnect
  // with one is evicted by lib/webhook.js. The seats release below calls onExpire
  // for an immediate release as well as at grace expiry, so wrapping it covers both.
  function freeSeat(meetingId, userId, { onExpire, ...rest } = {}) {
    seats.releaseSeat(meetingId, userId, {
      ...rest,
      onExpire: () => {
        livekit?.evict(meetingId, userId); // never rejects
        onExpire?.();
      },
    });
  }

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

  // The one place the room hears who is presenting, so the lock and what every
  // client believes cannot drift apart.
  function broadcastScreen(meetingId) {
    io.to(roomChannel(meetingId)).emit('screen:state', { sharerUserId: seats.screenSharer(meetingId)?.userId ?? null });
  }

  // Ends a share if `holderSocketId` holds the lock: release (synchronously, so a
  // request racing this sees it gone), revoke at LiveKit (fire and forget; never
  // rejects), tell the room.
  function releaseScreen(meetingId, holderSocketId) {
    const released = seats.releaseScreenLock(meetingId, holderSocketId);
    if (!released) return;
    livekit?.revokeScreenShare(meetingId, released.userId);
    broadcastScreen(meetingId);
  }

  // Presence and lobby are NOT broadcast here: callers admitting several people at
  // once broadcast one time at the end instead of once per person.
  async function admit(socket, meetingId, isHostUser, result) {
    // A share belongs to the page that started it. When a newer page takes this seat,
    // the old page's share ends now — before the awaits below, so it cannot keep
    // presenting while the DB catches up — and the new page never inherits it.
    if (result.replacedSocketId) releaseScreen(meetingId, result.replacedSocketId);
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
    // Arriving mid-presentation: say who is presenting; later changes arrive by broadcastScreen.
    socket.emit('screen:state', { sharerUserId: seats.screenSharer(meetingId)?.userId ?? null });
  }

  // drainQueue already took the seat; this only runs the admission side effects.
  async function admitDrained(entry, meetingId) {
    const socket = io.sockets.sockets.get(entry.socketId);
    if (!socket) {
      // Their tab is gone: hand the seat straight back rather than leak it.
      freeSeat(meetingId, entry.userId, { immediate: true });
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
    broadcastScreen(meetingId); // releaseSeat drops the lock with the seat
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

  // Every host-only event runs through this. Authorization is a server check:
  // whether the client renders the button is irrelevant.
  function hostGuard(socket) {
    const { meetingId, userId } = socket.data;
    const meta = meetingId ? liveMeetings.get(meetingId) : null;
    if (!meta || meta.hostId !== userId) {
      socket.emit('error:forbidden');
      return null;
    }
    return { meetingId, meta };
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
      // host:end-meeting (or the last seat emptying) can land during the awaits above.
      // Both drop the cache entry, so a join that read it before the end must not seat
      // anyone in a meeting that is over.
      if (!liveMeetings.has(meetingId)) return socket.emit('meeting:denied', { reason: 'ended' });
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
      freeSeat(meetingId, userId, { immediate: true });
      socket.leave(roomChannel(meetingId));
      socket.data.meetingId = null;
      await onSeatFreed(meetingId);
      socket.disconnect(true);
    });

    // ZyloChat. roomChannel holds exactly the seated members — a socket joins it only
    // inside admit() — so joining it is both the authorization scope and the delivery
    // scope. But socket.data.meetingId is also set for people still in the lobby, so
    // it proves nothing on its own: the seat lookup is the real check. The name comes
    // from the seat, never the payload, so nobody can speak as someone else.
    on(socket, 'chat:message', ({ text } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      const seat = seats.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return;
      const clean = validateChatText(text);
      if (!clean) return; // a client bug or a probe; see host:set-admission below
      io.to(roomChannel(meetingId)).emit('chat:message', { userId, name: seat.name, text: clean, ts: Date.now() });
    });

    // ZyloLive. From the seat check to tryTakeScreenLock nothing awaits, so two
    // people pressing ZyloLive together cannot both win: Node finishes one
    // handler's synchronous run before starting the other's.
    on(socket, 'screen:request', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      const seat = seats.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return; // lobby or replaced tab: ignored, like chat
      const meta = liveMeetings.get(meetingId);
      if (!meta) return;
      if (!livekit) return socket.emit('screen:denied', { reason: 'unavailable' });
      if (meta.screenSharePolicy === 'host_only' && meta.hostId !== userId) {
        return socket.emit('screen:denied', { reason: 'host_only' });
      }
      const lock = seats.tryTakeScreenLock(meetingId, { userId, socketId: socket.id });
      if (!lock.ok) {
        const sharerName = seats.seatFor(meetingId, lock.sharerUserId)?.name ?? 'someone';
        return socket.emit('screen:denied', { reason: 'busy', sharerName });
      }
      try {
        await livekit.grantScreenShare(meetingId, userId);
      } catch (err) {
        console.error('screen share grant failed:', err.message);
        seats.releaseScreenLock(meetingId, socket.id);
        return socket.emit('screen:denied', { reason: 'unavailable' });
      }
      // The lock can be released while the grant is in flight (host stop, policy
      // switch, this tab closing), and that path's revoke may have reached LiveKit
      // before our grant did. Revoke again rather than leave a permission with no lock.
      if (seats.screenSharer(meetingId)?.socketId !== socket.id) {
        livekit.revokeScreenShare(meetingId, userId);
        return;
      }
      socket.emit('screen:granted');
      broadcastScreen(meetingId);
    });

    on(socket, 'screen:stop', () => {
      const { meetingId } = socket.data;
      if (meetingId) releaseScreen(meetingId, socket.id); // only the holder's socket releases
    });

    on(socket, 'lobby:admit', async ({ userId } = {}, ack) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      const entry = seats.queuedEntries(meetingId).find((e) => e.userId === userId);
      if (!entry) return ack?.({ ok: false, reason: 'gone' });

      const result = seats.tryTakeSeat(meetingId, { ...entry, isHost: false, max: meta.maxParticipants });
      // Full: the host is told, and the person keeps their place in the lobby so
      // they can be admitted when a seat frees.
      if (!result.ok) return ack?.({ ok: false, reason: 'full' });

      seats.removeFromQueue(meetingId, userId);
      const waiting = io.sockets.sockets.get(entry.socketId);
      if (!waiting) {
        freeSeat(meetingId, userId, { immediate: true });
        broadcastLobby(meetingId);
        return ack?.({ ok: false, reason: 'gone' });
      }
      await admit(waiting, meetingId, false, result);
      ack?.({ ok: true });
      broadcastPresence(meetingId);
      broadcastLobby(meetingId);
    });

    on(socket, 'lobby:deny', ({ userId } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      const entry = seats.queuedEntries(meetingId).find((e) => e.userId === userId);
      if (!entry) return;
      seats.removeFromQueue(meetingId, userId);
      const waiting = io.sockets.sockets.get(entry.socketId);
      if (waiting) {
        waiting.data.meetingId = null;
        waiting.emit('meeting:denied', { reason: 'denied' });
      }
      broadcastLobby(meetingId);
    });

    on(socket, 'host:set-admission', async ({ mode } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      // The host is authenticated, so a malformed payload is a client bug, not an
      // authorization failure: ignore it rather than emit error:forbidden.
      if (mode !== 'auto' && mode !== 'manual') return;

      meta.admission = mode;
      await db.query('UPDATE meetings SET admission = $1 WHERE id = $2', [mode, meetingId]);
      io.to(roomChannel(meetingId)).emit('meeting:settings', {
        admission: mode,
        screenSharePolicy: meta.screenSharePolicy,
      });
      if (mode === 'auto') {
        for (const entry of seats.drainQueue(meetingId, meta.maxParticipants)) {
          await admitDrained(entry, meetingId);
        }
        broadcastPresence(meetingId);
      }
      broadcastLobby(meetingId);
    });

    on(socket, 'host:set-screen-policy', async ({ policy } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (policy !== 'anyone' && policy !== 'host_only') return; // client bug; see host:set-admission
      // Before the first await: screen:request reads meta, so a request racing this
      // already sees the new policy, and a participant's share ends now.
      meta.screenSharePolicy = policy;
      const sharer = seats.screenSharer(meetingId);
      if (policy === 'host_only' && sharer && sharer.userId !== meta.hostId) releaseScreen(meetingId, sharer.socketId);
      io.to(roomChannel(meetingId)).emit('meeting:settings', { admission: meta.admission, screenSharePolicy: policy });
      await db.query('UPDATE meetings SET screen_share_policy = $1 WHERE id = $2', [policy, meetingId]);
    });

    on(socket, 'host:stop-share', ({ userId } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      // Named, not "whoever is sharing": a click aimed at Priya's share must not end
      // Raj's if the lock changed hands while the menu was open.
      const sharer = seats.screenSharer(guard.meetingId);
      if (sharer && sharer.userId === userId) releaseScreen(guard.meetingId, sharer.socketId);
    });

    on(socket, 'host:mute', ({ userId } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      if (typeof userId !== 'string' || !seats.hasSeat(guard.meetingId, userId)) return;
      livekit?.muteMic(guard.meetingId, userId); // never rejects; they can unmute themselves
    });

    on(socket, 'host:kick', async ({ userId } = {}) => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (typeof userId !== 'string' || userId === meta.hostId) return;
      // The DB first: once this commits, a rejoin (isRemoved) and a token request
      // are refused, and it survives a restart. Anyone ever admitted has a row, so
      // someone who left a second before the click is still blocked.
      const { rowCount } = await db.query(
        `UPDATE meeting_participants SET removed_at = now()
         WHERE meeting_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [meetingId, userId],
      );
      if (rowCount === 0) return; // never admitted, or already removed
      const seatSocketId = seats.seatSocketId(meetingId, userId);
      const queuedSocketId = seats.queueSocketId(meetingId, userId);
      seats.removeFromQueue(meetingId, userId);
      for (const id of new Set([seatSocketId, queuedSocketId])) {
        const target = id && io.sockets.sockets.get(id);
        if (!target) continue;
        target.data.meetingId = null;
        target.leave(roomChannel(meetingId));
        // Before LiveKit hears anything, so the client tears media down on its
        // "removed" screen instead of first seeing a media error.
        target.emit('meeting:removed');
      }
      if (seatSocketId) freeSeat(meetingId, userId, { immediate: true }); // evicts; drops the lock
      await onSeatFreed(meetingId);
    });

    on(socket, 'host:end-meeting', async () => {
      const guard = hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      // The DB first, so from the moment anyone is told, a rejoin reads ended_at and
      // is refused — and the meeting is already in everyone's Previous list.
      await markEnded(meetingId);
      const socketIds = [
        ...seats.listSeats(meetingId).map((s) => s.socketId),
        ...seats.queuedEntries(meetingId).map((e) => e.socketId),
      ];
      seats.clearMeeting(meetingId); // seats, queue, grace timers and the ZyloLive lock
      liveMeetings.delete(meetingId);
      for (const id of socketIds) {
        const target = io.sockets.sockets.get(id);
        if (!target) continue;
        target.data.meetingId = null;
        target.leave(roomChannel(meetingId));
        target.emit('meeting:ended');
      }
      livekit?.endRoom(meetingId); // after the sockets, as in host:kick; never rejects
    });

    on(socket, 'disconnect', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      // A share never outlives the page that started it: closing the tab or losing the
      // socket ends it now, not when the seat's 30 s grace runs out (Deviation 1).
      releaseScreen(meetingId, socket.id);
      // A newer connection may already hold this queue entry (two tabs). Never
      // pull it out from under them.
      if (seats.queueSocketId(meetingId, userId) === socket.id && seats.removeFromQueue(meetingId, userId)) {
        broadcastLobby(meetingId);
      }
      // Same guard for the seat itself.
      if (seats.seatSocketId(meetingId, userId) !== socket.id) return;
      freeSeat(meetingId, userId, {
        graceMs,
        onExpire: () => {
          onSeatFreed(meetingId).catch((err) => console.error('seat release failed:', err.message));
        },
      });
    });
  });
}

// Seat state lives in memory, so anything still marked started-but-not-ended
// belongs to a process that is gone. Run once on boot.
async function closeStaleMeetings(db) {
  await db.query('UPDATE meetings SET ended_at = now() WHERE started_at IS NOT NULL AND ended_at IS NULL');
}

module.exports = { registerRoomHandlers, closeStaleMeetings, roomChannel };
