const { validateChatText } = require('./chatRules');
const { isConvoLang, validateCaption } = require('./captionRules');
const { SOCKET_POLICIES, takeToken } = require('./rateLimit');
const { GRACE_MS } = require('./roomStore');

const roomChannel = (meetingId) => `meeting:${meetingId}`;

// Per-socket buckets (SOCKET_POLICIES). A socket lives on one server for its whole
// life, so these need no Redis round trip; captions are the busiest event in Zylo.
// The per-IP connection limit (limitConnections) stops a reconnect from buying a
// fresh bucket.
function allowEvent(socket, name) {
  const { rate, burst } = SOCKET_POLICIES[name];
  const now = Date.now();
  const buckets = (socket.data.buckets ??= {});
  return takeToken((buckets[name] ??= { tokens: burst, at: now }), now, rate, burst);
}

// Seats, the lobby, the screen-share lock and live settings live in the room store
// (Redis), shared by every API server. A socket may live on another server, so
// sockets are reached by id: io.to(id) sends, io.in(id).socketsJoin/socketsLeave
// moves it, io.in(id).fetchSockets() asks whether it's still connected. All of these
// work with the default in-memory adapter too. socket.data.meetingId is only a hint:
// every handler that acts checks in the store that this socket holds the seat or
// lobby entry it acts through.
function registerRoomHandlers(io, { db, store, livekit = null, graceMs = GRACE_MS }) {
  const graceTimers = new Set();
  let stopped = false;

  async function loadMeetingMeta(meetingId) {
    const live = await store.getMeta(meetingId);
    if (live) return live;
    const { rows } = await db.query(
      `SELECT host_id, admission, screen_share_policy, max_participants, mode, ended_at
       FROM meetings WHERE id = $1`,
      [meetingId],
    );
    if (rows.length === 0) return null;
    if (rows[0].ended_at) return { ended: true };
    const meta = {
      hostId: rows[0].host_id,
      admission: rows[0].admission,
      screenSharePolicy: rows[0].screen_share_policy,
      maxParticipants: rows[0].max_participants,
      mode: rows[0].mode,
    };
    // Refused for an hour after the meeting ended: a join that read the row just
    // before "End for all" committed must not bring the room back.
    if (!(await store.initMeta(meetingId, meta))) return { ended: true };
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

  const isConnected = async (socketId) => (await io.in(socketId).fetchSockets()).length > 0;

  // Every seat release goes through here, so none can forget LiveKit: the seat is
  // the only thing that authorizes media. socketId: release only if that socket
  // still holds the seat; null for the host acting on someone.
  async function freeSeat(meetingId, userId, socketId = null) {
    const released = await store.releaseSeat(meetingId, userId, socketId);
    if (released) livekit?.evict(meetingId, userId); // never rejects
    return released;
  }

  async function presenceOf(meetingId) {
    return (await store.listSeats(meetingId)).map(({ userId, name, imageUrl, isHost, lang }) => ({
      userId,
      name,
      imageUrl,
      isHost,
      lang: lang ?? null,
    }));
  }

  // exceptSocketId: someone who was just sent the roster by admit() and needs no second copy.
  async function broadcastPresence(meetingId, exceptSocketId = null) {
    const people = await presenceOf(meetingId);
    io.to(roomChannel(meetingId)).except(exceptSocketId ?? []).emit('room:presence', { people });
  }

  // One call refreshes both sides of the lobby: the host's list, and every waiting
  // person's position.
  async function broadcastLobby(meetingId) {
    const [meta, waiting, seated] = await Promise.all([
      store.getMeta(meetingId),
      store.queuedEntries(meetingId),
      store.listSeats(meetingId),
    ]);
    const host = seated.find((seat) => seat.isHost);
    if (host) {
      io.to(host.socketId).emit('lobby:update', {
        waiting: waiting.map(({ userId, name, imageUrl }) => ({ userId, name, imageUrl })),
      });
    }
    waiting.forEach((entry, index) => {
      io.to(entry.socketId).emit('meeting:waiting', { position: index + 1, manual: meta?.admission === 'manual' });
    });
  }

  // The one place the room hears who is presenting.
  async function broadcastScreen(meetingId) {
    const sharer = await store.screenSharer(meetingId);
    io.to(roomChannel(meetingId)).emit('screen:state', { sharerUserId: sharer?.userId ?? null });
  }

  // Ends a share if `holderSocketId` holds the lock: release (one script, so a
  // request racing this sees it gone), revoke at LiveKit, tell the room.
  async function releaseScreen(meetingId, holderSocketId) {
    const released = await store.releaseScreenLock(meetingId, holderSocketId);
    if (!released) return;
    livekit?.revokeScreenShare(meetingId, released.userId);
    await broadcastScreen(meetingId);
  }

  // Runs the admission side effects for a socket that already holds its seat, on
  // whichever server it lives. Room-wide presence and lobby broadcasts are the caller's.
  async function admit(socketId, meetingId, userId, isHostUser, replacedSocketId) {
    // A share belongs to the page that started it: a newer page taking this seat
    // ends the old page's share, and never inherits it.
    if (replacedSocketId) await releaseScreen(meetingId, replacedSocketId);
    await upsertParticipant(meetingId, userId, isHostUser);
    await markStarted(meetingId);
    if (replacedSocketId) {
      io.in(replacedSocketId).socketsLeave(roomChannel(meetingId));
      io.to(replacedSocketId).emit('meeting:replaced');
    }
    io.in(socketId).socketsJoin(roomChannel(meetingId));
    // Read first, then send all three back to back: the client holds the roster and
    // who is presenting by the time it has handled "admitted", as it did when this
    // all lived in one process. Straight to this socket: on another server the room
    // join above can land after the caller's room-wide broadcast.
    const [people, sharer] = await Promise.all([presenceOf(meetingId), store.screenSharer(meetingId)]);
    io.to(socketId).emit('meeting:admitted');
    io.to(socketId).emit('room:presence', { people });
    io.to(socketId).emit('screen:state', { sharerUserId: sharer?.userId ?? null });
  }

  // drainQueue already took the seat; a tab that closed meanwhile hands it straight back.
  async function admitDrained(entry, meetingId) {
    if (!(await isConnected(entry.socketId))) {
      await freeSeat(meetingId, entry.userId, entry.socketId);
      return;
    }
    await admit(entry.socketId, meetingId, entry.userId, false, null);
  }

  // Seats everyone the lobby has room for (nobody while admission is manual). A seat
  // handed back by a closed tab is offered again, so it is asked until a round seats no one.
  async function drainLobby(meetingId) {
    for (;;) {
      const drained = await store.drainQueue(meetingId);
      if (drained.length === 0) return;
      for (const entry of drained) await admitDrained(entry, meetingId);
    }
  }

  async function onSeatFreed(meetingId) {
    if (!(await store.getMeta(meetingId))) return;
    await drainLobby(meetingId);
    await broadcastPresence(meetingId);
    await broadcastScreen(meetingId); // a released seat drops the lock with it
    await broadcastLobby(meetingId);
    if ((await store.listSeats(meetingId)).length > 0) return;
    await endEmptyRoom(meetingId);
  }

  // Nobody is seated any more, so the meeting is over. Anyone still in the lobby is
  // told rather than left spinning.
  async function endEmptyRoom(meetingId) {
    for (const entry of await store.queuedEntries(meetingId)) {
      io.to(entry.socketId).emit('meeting:denied', { reason: 'ended' });
    }
    const { rowCount } = await markEnded(meetingId);
    await store.clearMeeting(meetingId, { ended: rowCount > 0 });
  }

  // Every host-only event runs through this. Authorization is a server check:
  // whether the client renders the button is irrelevant. The host's seat must be
  // held by this very socket: a replaced tab keeps a stale meetingId.
  async function hostGuard(socket) {
    if (!allowEvent(socket, 'host')) {
      socket.emit('rate-limited', { event: 'host' });
      return null;
    }
    const { meetingId, userId } = socket.data;
    const meta = meetingId ? await store.getMeta(meetingId) : null;
    const seat = meta && meta.hostId === userId ? await store.seatFor(meetingId, userId) : null;
    if (!seat || seat.socketId !== socket.id) {
      socket.emit('error:forbidden');
      return null;
    }
    return { meetingId, meta };
  }

  // Started only after markGrace resolved, so it can't fire before the deadline
  // Redis stamped. Does nothing if the person came back on any server.
  function startGraceTimer(meetingId, userId, socketId) {
    if (stopped) return;
    const timer = setTimeout(() => {
      graceTimers.delete(timer);
      expireGrace(meetingId, userId, socketId).catch((err) => console.error('seat release failed:', err.message));
    }, graceMs);
    timer.unref(); // a held seat must never keep the process alive
    graceTimers.add(timer);
  }

  async function expireGrace(meetingId, userId, socketId) {
    if (!(await store.releaseIfStale(meetingId, userId, socketId))) return;
    livekit?.evict(meetingId, userId);
    await onSeatFreed(meetingId);
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
    on(socket, 'meeting:join-request', async ({ meetingId, lang } = {}) => {
      if (!allowEvent(socket, 'meeting:join-request')) return socket.emit('rate-limited', { event: 'meeting:join-request' });
      if (typeof meetingId !== 'string') return socket.emit('meeting:denied', { reason: 'not_found' });
      const meta = await loadMeetingMeta(meetingId);
      if (!meta) return socket.emit('meeting:denied', { reason: 'not_found' });
      if (meta.ended) return socket.emit('meeting:denied', { reason: 'ended' });

      const { userId } = socket.data;
      if (await isRemoved(meetingId, userId)) return socket.emit('meeting:denied', { reason: 'removed' });

      const isHostUser = meta.hostId === userId;
      const { name, imageUrl } = await userInfo(userId);
      // lang only means anything in a translator convo, and only if it is one of
      // the supported codes; anything else silently becomes null, like chat.
      const seatLang = meta.mode === 'translator' && isConvoLang(lang) ? lang : null;
      // One script decides the rest atomically: removed or ended while we awaited,
      // a reconnect taking its own seat back, the manual lobby, the host's reserved
      // seat, a full translator convo, a full room's lobby.
      const outcome = await store.join(
        meetingId,
        { userId, socketId: socket.id, name, imageUrl, lang: seatLang },
        { isHost: isHostUser },
      );
      if (outcome.result === 'ended' || outcome.result === 'removed' || outcome.result === 'full') {
        return socket.emit('meeting:denied', { reason: outcome.result });
      }
      socket.data.meetingId = meetingId;
      if (outcome.result === 'queued') return broadcastLobby(meetingId);
      await admit(socket.id, meetingId, userId, isHostUser, outcome.replacedSocketId);
      await broadcastPresence(meetingId, socket.id);
      // A host arriving needs to see whoever is already waiting for them.
      if (isHostUser) await broadcastLobby(meetingId);
    });

    // Translator convos only, and only through the seat this socket holds.
    on(socket, 'convo:set-lang', async ({ lang } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'convo:set-lang')) return;
      if (!isConvoLang(lang)) return;
      const meta = await store.getMeta(meetingId);
      if (!meta || meta.mode !== 'translator') return;
      if (!(await store.setSeatLang(meetingId, userId, socket.id, lang))) return;
      await broadcastPresence(meetingId);
    });

    // Translator convos only. Identity comes from the seat, never the payload.
    // socket.to (not io.to) excludes the sender, which already rendered its own caption.
    on(socket, 'convo:caption', async (payload) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      const [seat, meta] = await Promise.all([store.seatFor(meetingId, userId), store.getMeta(meetingId)]);
      if (!seat || seat.socketId !== socket.id) return;
      if (!meta || meta.mode !== 'translator') return;
      // Captions are chatty (interim results, client-throttled to ~4/s); extras past
      // the bucket are dropped silently, since the next interim replaces them anyway.
      if (!allowEvent(socket, 'convo:caption')) return;
      const clean = validateCaption(payload);
      if (!clean) return;
      socket.to(roomChannel(meetingId)).emit('convo:caption', { userId, name: seat.name, ...clean, ts: Date.now() });
    });

    on(socket, 'meeting:leave', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return socket.disconnect(true);
      // Only what this socket owns: a replaced tab's leave must not free the new tab's seat.
      await store.removeFromQueue(meetingId, userId, socket.id);
      await freeSeat(meetingId, userId, socket.id);
      socket.leave(roomChannel(meetingId));
      socket.data.meetingId = null;
      await onSeatFreed(meetingId);
      socket.disconnect(true);
    });

    // ZyloChat. The name comes from the seat, never the payload.
    on(socket, 'chat:message', async ({ text } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'chat:message')) return socket.emit('rate-limited', { event: 'chat:message' });
      const seat = await store.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return;
      const clean = validateChatText(text);
      if (!clean) return;
      io.to(roomChannel(meetingId)).emit('chat:message', { userId, name: seat.name, text: clean, ts: Date.now() });
    });

    // ZyloLive. The lock script re-checks the seat and the host-only policy, so two
    // people pressing ZyloLive together (on any servers) cannot both win.
    on(socket, 'screen:request', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'screen:request')) return socket.emit('rate-limited', { event: 'screen:request' });
      const seat = await store.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return; // lobby or replaced tab: ignored, like chat
      if (!livekit) return socket.emit('screen:denied', { reason: 'unavailable' });
      const lock = await store.takeScreenLock(meetingId, { userId, socketId: socket.id });
      if (lock.reason === 'noseat') return;
      if (lock.reason === 'host_only') return socket.emit('screen:denied', { reason: 'host_only' });
      if (!lock.ok) {
        const sharerName = (await store.seatFor(meetingId, lock.sharerUserId))?.name ?? 'someone';
        return socket.emit('screen:denied', { reason: 'busy', sharerName });
      }
      try {
        await livekit.grantScreenShare(meetingId, userId);
      } catch (err) {
        console.error('screen share grant failed:', err.message);
        await store.releaseScreenLock(meetingId, socket.id);
        livekit.revokeScreenShare(meetingId, userId); // never rejects; the grant may have applied
        return socket.emit('screen:denied', { reason: 'unavailable' });
      }
      // The lock can be released while the grant is in flight (host stop, policy
      // switch, this tab closing). Revoke again rather than leave a permission with no lock.
      if ((await store.screenSharer(meetingId))?.socketId !== socket.id) {
        livekit.revokeScreenShare(meetingId, userId);
        return;
      }
      socket.emit('screen:granted');
      await broadcastScreen(meetingId);
    });

    on(socket, 'screen:stop', async () => {
      const { meetingId } = socket.data;
      if (meetingId) await releaseScreen(meetingId, socket.id); // only the holder's socket releases
    });

    on(socket, 'lobby:admit', async ({ userId } = {}, ack) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      if (typeof userId !== 'string') return ack?.({ ok: false, reason: 'gone' });
      // One script: still waiting, a seat free, then seated and out of the lobby.
      const outcome = await store.admitFromQueue(meetingId, userId);
      if (outcome.result === 'gone') return ack?.({ ok: false, reason: 'gone' });
      // Full: the host is told, and the person keeps their place in the lobby.
      if (outcome.result === 'full') return ack?.({ ok: false, reason: 'full' });
      if (!(await isConnected(outcome.entry.socketId))) {
        await freeSeat(meetingId, userId, outcome.entry.socketId);
        await onSeatFreed(meetingId); // the seat goes to the next in the lobby if admission is auto
        return ack?.({ ok: false, reason: 'gone' });
      }
      await admit(outcome.entry.socketId, meetingId, userId, false, null);
      ack?.({ ok: true });
      await broadcastPresence(meetingId);
      await broadcastLobby(meetingId);
    });

    on(socket, 'lobby:deny', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      if (typeof userId !== 'string') return;
      const socketId = await store.queueSocketId(meetingId, userId);
      if (!socketId || !(await store.removeFromQueue(meetingId, userId, socketId))) return;
      io.to(socketId).emit('meeting:denied', { reason: 'denied' });
      await broadcastLobby(meetingId);
    });

    on(socket, 'host:set-admission', async ({ mode } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      // A translator convo is always auto admission: a silent no-op.
      if (meta.mode === 'translator') return;
      // A malformed payload from an authenticated host is a client bug: ignore it.
      if (mode !== 'auto' && mode !== 'manual') return;
      await store.setMetaField(meetingId, 'admission', mode);
      await db.query('UPDATE meetings SET admission = $1 WHERE id = $2', [mode, meetingId]);
      io.to(roomChannel(meetingId)).emit('meeting:settings', { admission: mode, screenSharePolicy: meta.screenSharePolicy });
      if (mode === 'auto') {
        await drainLobby(meetingId);
        await broadcastPresence(meetingId);
      }
      await broadcastLobby(meetingId);
    });

    on(socket, 'host:set-screen-policy', async ({ policy } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (policy !== 'anyone' && policy !== 'host_only') return; // client bug; see host:set-admission
      // Written first: the lock script checks the policy, so no participant can take
      // the lock after this line, and one who took it just before loses it below.
      await store.setMetaField(meetingId, 'screenSharePolicy', policy);
      const sharer = await store.screenSharer(meetingId);
      if (policy === 'host_only' && sharer && sharer.userId !== meta.hostId) await releaseScreen(meetingId, sharer.socketId);
      io.to(roomChannel(meetingId)).emit('meeting:settings', { admission: meta.admission, screenSharePolicy: policy });
      await db.query('UPDATE meetings SET screen_share_policy = $1 WHERE id = $2', [policy, meetingId]);
    });

    on(socket, 'host:stop-share', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      // Named, not "whoever is sharing": a click aimed at Priya's share must not end
      // Raj's if the lock changed hands while the menu was open.
      const sharer = await store.screenSharer(guard.meetingId);
      if (sharer && sharer.userId === userId) await releaseScreen(guard.meetingId, sharer.socketId);
    });

    on(socket, 'host:mute', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      if (typeof userId !== 'string' || !(await store.hasSeat(guard.meetingId, userId))) return;
      livekit?.muteMic(guard.meetingId, userId); // never rejects; they can unmute themselves
    });

    on(socket, 'host:kick', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (typeof userId !== 'string' || userId === meta.hostId) return;
      // In the store before the DB await below: the join script checks this set, so a
      // join already past its own isRemoved check can't seat them after this line.
      await store.addRemoved(meetingId, userId);
      // The DB next: once this commits, a rejoin (isRemoved) and a token request are
      // refused, and it survives a restart.
      const { rowCount } = await db.query(
        `UPDATE meeting_participants SET removed_at = now()
         WHERE meeting_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [meetingId, userId],
      );
      const seat = await store.seatFor(meetingId, userId);
      const queuedSocketId = await store.queueSocketId(meetingId, userId);
      if (rowCount === 0 && !seat && !queuedSocketId) return;
      await store.removeFromQueue(meetingId, userId);
      for (const id of new Set([seat?.socketId, queuedSocketId])) {
        if (!id) continue;
        io.in(id).socketsLeave(roomChannel(meetingId));
        // Before LiveKit hears anything, so the client tears media down on its
        // "removed" screen instead of first seeing a media error.
        io.to(id).emit('meeting:removed');
      }
      if (seat) await freeSeat(meetingId, userId); // evicts; drops the lock
      await onSeatFreed(meetingId);
    });

    on(socket, 'host:end-meeting', async () => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      // The DB first, so from the moment anyone is told, a rejoin reads ended_at and
      // is refused, and the meeting is already in everyone's Previous list.
      await markEnded(meetingId);
      const socketIds = await store.clearMeeting(meetingId, { ended: true });
      for (const id of socketIds) {
        io.in(id).socketsLeave(roomChannel(meetingId));
        io.to(id).emit('meeting:ended');
      }
      livekit?.endRoom(meetingId); // after the sockets, as in host:kick; never rejects
    });

    on(socket, 'disconnect', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      // A share never outlives the page that started it.
      await releaseScreen(meetingId, socket.id);
      // A newer connection may hold this lobby entry or seat (two tabs): only ours.
      if (await store.removeFromQueue(meetingId, userId, socket.id)) await broadcastLobby(meetingId);
      if (!(await store.markGrace(meetingId, userId, socket.id, graceMs))) return;
      startGraceTimer(meetingId, userId, socket.id);
    });
  });

  return {
    // Cancels pending grace timers and starts no new ones (tests; shutdown later).
    stop() {
      stopped = true;
      for (const timer of graceTimers) clearTimeout(timer);
      graceTimers.clear();
    },
  };
}

// Boot clean-up while there is one API server (Task 10 replaces it with the sweeper):
// rooms left in Redis belong to a process that is gone, and so do meetings marked
// started but never ended.
async function closeStaleMeetings(db, store) {
  for (const code of await store.liveMeetings()) await store.clearMeeting(code);
  await db.query('UPDATE meetings SET ended_at = now() WHERE started_at IS NOT NULL AND ended_at IS NULL');
}

module.exports = { registerRoomHandlers, closeStaleMeetings, roomChannel };
