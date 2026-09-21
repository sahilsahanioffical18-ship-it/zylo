const test = require('node:test');
const assert = require('node:assert/strict');
const seats = require('../lib/seats');

const person = (n) => ({ userId: `u${n}`, socketId: `s${n}`, name: `User ${n}`, imageUrl: null });

test('the host seat is reserved on top of the max - 1 participant seats', () => {
  const id = 'm-reserved-host';
  assert.equal(seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 }).ok, true);
  assert.equal(seats.tryTakeSeat(id, { ...person(2), isHost: false, max: 3 }).ok, true);
  assert.equal(seats.tryTakeSeat(id, { ...person(3), isHost: false, max: 3 }).ok, false);
  assert.equal(seats.tryTakeSeat(id, { ...person(9), isHost: true, max: 3 }).ok, true);
  assert.equal(seats.listSeats(id).length, 3);
  seats.clearMeeting(id);
});

test('two calls for the last seat: exactly one wins', () => {
  const id = 'm-race';
  seats.tryTakeSeat(id, { ...person(1), isHost: true, max: 3 });
  seats.tryTakeSeat(id, { ...person(2), isHost: false, max: 3 });
  // Back to back, no await in between — this is the race the spec describes.
  const a = seats.tryTakeSeat(id, { ...person(3), isHost: false, max: 3 });
  const b = seats.tryTakeSeat(id, { ...person(4), isHost: false, max: 3 });
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  seats.clearMeeting(id);
});

test('the queue hands out FIFO positions and shifts as people are admitted', () => {
  const id = 'm-fifo';
  // Both non-host slots (max - 1 = 2) are filled by non-host users here — this
  // test is about FIFO draining, not host reservation (that has its own test
  // above), so releasing one of these two is what frees exactly one slot.
  seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 });
  seats.tryTakeSeat(id, { ...person(2), isHost: false, max: 3 });
  assert.equal(seats.enqueue(id, person(3)), 1);
  assert.equal(seats.enqueue(id, person(4)), 2);
  assert.equal(seats.enqueue(id, person(5)), 3);
  // Re-requesting only refreshes the entry; it never duplicates or moves you back.
  assert.equal(seats.enqueue(id, { ...person(4), socketId: 's4b' }), 2);
  assert.deepEqual(seats.queuedEntries(id)[1].socketId, 's4b');

  assert.deepEqual(seats.drainQueue(id, 3), []); // still full
  seats.releaseSeat(id, 'u2', { immediate: true });
  const admitted = seats.drainQueue(id, 3);
  assert.deepEqual(admitted.map((e) => e.userId), ['u3']);
  assert.equal(seats.queuePosition(id, 'u4'), 1);
  assert.equal(seats.queuePosition(id, 'u5'), 2);
  assert.equal(seats.queuePosition(id, 'u3'), null);
  seats.clearMeeting(id);
});

test('queueSocketId reports the current entry, refreshed by re-enqueuing', () => {
  const id = 'm-queue-socket';
  assert.equal(seats.queueSocketId(id, 'u1'), null); // not queued at all
  seats.enqueue(id, person(1));
  assert.equal(seats.queueSocketId(id, 'u1'), 's1');
  seats.enqueue(id, { ...person(1), socketId: 's1b' });
  assert.equal(seats.queueSocketId(id, 'u1'), 's1b');
  seats.clearMeeting(id);
});

test('manual to auto: draining admits in order until seats run out', () => {
  const id = 'm-drain';
  seats.tryTakeSeat(id, { ...person(1), isHost: true, max: 4 });
  seats.enqueue(id, person(2));
  seats.enqueue(id, person(3));
  seats.enqueue(id, person(4));
  const admitted = seats.drainQueue(id, 4);
  assert.deepEqual(admitted.map((e) => e.userId), ['u2', 'u3', 'u4'].slice(0, 3));
  assert.equal(seats.listSeats(id).length, 4);
  assert.deepEqual(seats.queuedEntries(id), []);
  seats.clearMeeting(id);
});

test('manual to auto: whoever does not fit stays queued in order', () => {
  const id = 'm-drain-partial';
  seats.tryTakeSeat(id, { ...person(1), isHost: true, max: 3 });
  seats.enqueue(id, person(2));
  seats.enqueue(id, person(3));
  seats.enqueue(id, person(4));
  const admitted = seats.drainQueue(id, 3);
  assert.deepEqual(admitted.map((e) => e.userId), ['u2', 'u3']);
  assert.deepEqual(seats.queuedEntries(id).map((e) => e.userId), ['u4']);
  assert.equal(seats.queuePosition(id, 'u4'), 1);
  seats.clearMeeting(id);
});

test('reconnecting inside the grace period keeps the seat', async () => {
  const id = 'm-grace-keep';
  let expired = false;
  seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 });
  seats.releaseSeat(id, 'u1', { graceMs: 50, onExpire: () => { expired = true; } });
  const again = seats.tryTakeSeat(id, { ...person(1), socketId: 's1b', isHost: false, max: 3 });
  assert.equal(again.ok, true);
  assert.equal(again.replacedSocketId, 's1');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(expired, false);
  assert.equal(seats.hasSeat(id, 'u1'), true);
  assert.equal(seats.seatSocketId(id, 'u1'), 's1b');
  seats.clearMeeting(id);
});

test('the grace period expiring releases the seat and calls onExpire once', async () => {
  const id = 'm-grace-expire';
  let expired = 0;
  seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 });
  seats.releaseSeat(id, 'u1', { graceMs: 20, onExpire: () => { expired += 1; } });
  assert.equal(seats.hasSeat(id, 'u1'), true); // still held during the grace period
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired, 1);
  assert.equal(seats.hasSeat(id, 'u1'), false);
  seats.clearMeeting(id);
});

test('an explicit leave releases the seat immediately', () => {
  const id = 'm-leave';
  let expired = false;
  seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 });
  seats.releaseSeat(id, 'u1', { immediate: true, onExpire: () => { expired = true; } });
  assert.equal(seats.hasSeat(id, 'u1'), false);
  assert.equal(expired, true);
  seats.clearMeeting(id);
});

test('a second tab takes the seat over and reports the old socket', () => {
  const id = 'm-two-tabs';
  const first = seats.tryTakeSeat(id, { ...person(1), isHost: false, max: 3 });
  assert.equal(first.replacedSocketId, null);
  const second = seats.tryTakeSeat(id, { ...person(1), socketId: 's1b', isHost: false, max: 3 });
  assert.equal(second.ok, true);
  assert.equal(second.replacedSocketId, 's1');
  assert.equal(seats.listSeats(id).length, 1);
  assert.equal(seats.seatSocketId(id, 'u1'), 's1b');
  seats.clearMeeting(id);
});

test('seatFor returns the seat record, or null for a stranger or an unknown meeting', () => {
  const id = 'm-seat-for';
  seats.tryTakeSeat(id, { ...person(1), isHost: true, max: 3 });
  assert.deepEqual(seats.seatFor(id, 'u1'), { userId: 'u1', socketId: 's1', name: 'User 1', imageUrl: null, isHost: true });
  assert.equal(seats.seatFor(id, 'u2'), null); // seated meeting, unseated user
  assert.equal(seats.seatFor('m-does-not-exist', 'u1'), null); // unknown meeting
  seats.clearMeeting(id);
});

test('clearMeeting drops all state and cancels a pending grace timer', async () => {
  const id = 'm-clear';
  let expired = false;
  seats.tryTakeSeat(id, { ...person(1), isHost: true, max: 3 });
  seats.enqueue(id, person(2));
  seats.releaseSeat(id, 'u1', { graceMs: 20, onExpire: () => { expired = true; } });
  seats.clearMeeting(id);
  assert.deepEqual(seats.listSeats(id), []);
  assert.deepEqual(seats.queuedEntries(id), []);
  assert.equal(seats.queuePosition(id, 'u2'), null);
  assert.equal(seats.seatSocketId(id, 'u1'), null);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired, false);
});
