// In-memory seat and lobby state for live ZyloRooms. Pure logic: no I/O, and no
// `await` anywhere. Every capacity check and its write happen in one synchronous
// block, so two join requests that arrive together can never both see the last
// seat — Node finishes one call before starting the next.
//
// ponytail: single process only. With more than one server instance (Phase 5),
// move this to Redis with an atomic Lua script.

const GRACE_MS = 30_000;

/** @type {Map<string, { seats: Map<string, object>, queue: object[], graceTimers: Map<string, NodeJS.Timeout>, sharer: { userId: string, socketId: string } | null }>} */
const meetings = new Map();

function state(meetingId) {
  let s = meetings.get(meetingId);
  if (!s) {
    s = { seats: new Map(), queue: [], graceTimers: new Map(), sharer: null };
    meetings.set(meetingId, s);
  }
  return s;
}

function cancelGrace(s, userId) {
  const timer = s.graceTimers.get(userId);
  if (!timer) return;
  clearTimeout(timer);
  s.graceTimers.delete(userId);
}

function tryTakeSeat(meetingId, { userId, socketId, name, imageUrl, isHost, max }) {
  const s = state(meetingId);
  const existing = s.seats.get(userId);
  if (existing) {
    // Reconnect or second tab: one seat per userId. The new socket takes over.
    cancelGrace(s, userId);
    const replacedSocketId = existing.socketId === socketId ? null : existing.socketId;
    s.seats.set(userId, { socketId, name, imageUrl, isHost });
    return { ok: true, replacedSocketId };
  }
  if (!isHost) {
    // The host's seat is always reserved, so others share max - 1 seats.
    let taken = 0;
    for (const seat of s.seats.values()) if (!seat.isHost) taken += 1;
    if (taken >= max - 1) return { ok: false, replacedSocketId: null };
  }
  s.seats.set(userId, { socketId, name, imageUrl, isHost });
  return { ok: true, replacedSocketId: null };
}

function hasSeat(meetingId, userId) {
  return meetings.get(meetingId)?.seats.has(userId) ?? false;
}

// Authorize and read the name in one lookup — the token route and the chat
// handler both need this, and identity must come from the seat, not the request.
function seatFor(meetingId, userId) {
  const seat = meetings.get(meetingId)?.seats.get(userId);
  return seat ? { userId, ...seat } : null;
}

function seatSocketId(meetingId, userId) {
  return meetings.get(meetingId)?.seats.get(userId)?.socketId ?? null;
}

function listSeats(meetingId) {
  const s = meetings.get(meetingId);
  if (!s) return [];
  return [...s.seats].map(([userId, seat]) => ({ userId, ...seat }));
}

function releaseSeat(meetingId, userId, { immediate = false, graceMs = GRACE_MS, onExpire } = {}) {
  const s = meetings.get(meetingId);
  if (!s || !s.seats.has(userId)) return;
  cancelGrace(s, userId);
  const drop = () => {
    s.seats.delete(userId);
    // No seat, no share: the lock can never outlive the seat that earned it.
    if (s.sharer?.userId === userId) s.sharer = null;
    onExpire?.();
  };
  if (immediate) return drop();
  const timer = setTimeout(() => {
    s.graceTimers.delete(userId);
    drop();
  }, graceMs);
  timer.unref(); // a held seat must never keep the process alive
  s.graceTimers.set(userId, timer);
}

// The ZyloLive lock: one presenter per meeting. It belongs to a socket, not just a
// user — a share lives in the page that started it, so a second tab or a reconnect
// (Socket.IO gives it a new socket id) never inherits one. Same rule as
// tryTakeSeat: the check and the write are one synchronous block, so two people
// pressing ZyloLive together can never both win.
function tryTakeScreenLock(meetingId, { userId, socketId }) {
  const s = state(meetingId);
  if (s.sharer && s.sharer.socketId !== socketId) return { ok: false, sharerUserId: s.sharer.userId };
  s.sharer = { userId, socketId };
  return { ok: true, sharerUserId: userId };
}

function screenSharer(meetingId) {
  const sharer = meetings.get(meetingId)?.sharer;
  return sharer ? { ...sharer } : null;
}

// Releases the lock only if `socketId` holds it; returns who held it, or null if
// nothing changed. Callers that act for someone else (the host) look up the
// holder's socketId first, so the check is never skipped.
function releaseScreenLock(meetingId, socketId) {
  const s = meetings.get(meetingId);
  if (!s?.sharer || s.sharer.socketId !== socketId) return null;
  const released = s.sharer;
  s.sharer = null;
  return released;
}

function enqueue(meetingId, { userId, socketId, name, imageUrl }) {
  const s = state(meetingId);
  const index = s.queue.findIndex((e) => e.userId === userId);
  if (index !== -1) {
    // A retry refreshes the entry in place; it never costs you your position.
    Object.assign(s.queue[index], { socketId, name, imageUrl });
    return index + 1;
  }
  s.queue.push({ userId, socketId, name, imageUrl });
  return s.queue.length;
}

function queueSocketId(meetingId, userId) {
  const s = meetings.get(meetingId);
  return s?.queue.find((e) => e.userId === userId)?.socketId ?? null;
}

function removeFromQueue(meetingId, userId) {
  const s = meetings.get(meetingId);
  if (!s) return false;
  const index = s.queue.findIndex((e) => e.userId === userId);
  if (index === -1) return false;
  s.queue.splice(index, 1);
  return true;
}

function queuePosition(meetingId, userId) {
  const s = meetings.get(meetingId);
  if (!s) return null;
  const index = s.queue.findIndex((e) => e.userId === userId);
  return index === -1 ? null : index + 1;
}

function queuedEntries(meetingId) {
  return meetings.get(meetingId)?.queue.slice() ?? [];
}

// Serves both "a seat freed, advance the queue" and "the host switched manual to
// auto, empty the lobby in order" — they are the same operation.
function drainQueue(meetingId, max) {
  const s = meetings.get(meetingId);
  if (!s) return [];
  const admitted = [];
  while (s.queue.length > 0) {
    const entry = s.queue[0];
    if (!tryTakeSeat(meetingId, { ...entry, isHost: false, max }).ok) break;
    s.queue.shift();
    admitted.push(entry);
  }
  return admitted;
}

function clearMeeting(meetingId) {
  const s = meetings.get(meetingId);
  if (!s) return;
  for (const timer of s.graceTimers.values()) clearTimeout(timer);
  meetings.delete(meetingId);
}

module.exports = {
  GRACE_MS,
  tryTakeSeat,
  hasSeat,
  seatFor,
  seatSocketId,
  listSeats,
  releaseSeat,
  tryTakeScreenLock,
  screenSharer,
  releaseScreenLock,
  enqueue,
  queueSocketId,
  removeFromQueue,
  queuePosition,
  queuedEntries,
  drainQueue,
  clearMeeting,
};
