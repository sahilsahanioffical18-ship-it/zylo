const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../lib/cache');

const buf = (s) => Buffer.from(s);

test('a stored clip comes back; an unknown key is null', async () => {
  const cache = createCache();
  await cache.set('hi\nनमस्ते', buf('a'));
  assert.deepEqual(await cache.get('hi\nनमस्ते'), buf('a'));
  assert.equal(await cache.get('hi\nother'), null);
});

test('past max entries, the least recently used clip is evicted', async () => {
  const cache = createCache({ max: 2 });
  await cache.set('a', buf('a'));
  await cache.set('b', buf('b'));
  await cache.set('c', buf('c'));
  assert.equal(await cache.get('a'), null);
  assert.deepEqual(await cache.get('b'), buf('b'));
  assert.deepEqual(await cache.get('c'), buf('c'));
});

test('a read refreshes recency, so the unread clip is the one evicted', async () => {
  const cache = createCache({ max: 2 });
  await cache.set('a', buf('a'));
  await cache.set('b', buf('b'));
  await cache.get('a');
  await cache.set('c', buf('c'));
  assert.deepEqual(await cache.get('a'), buf('a'));
  assert.equal(await cache.get('b'), null);
});

test('a clip expires after the TTL', async () => {
  let t = 0;
  const cache = createCache({ ttlMs: 1000, now: () => t });
  await cache.set('a', buf('a'));
  t = 999;
  assert.deepEqual(await cache.get('a'), buf('a'));
  t = 1000;
  assert.equal(await cache.get('a'), null);
});
