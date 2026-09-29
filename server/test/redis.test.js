const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createRedis } = require('../lib/redis');
const { listen, fakeAuth, setupTestRedis, quietLog, settle } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };
// Nothing listens here, so a client pointed at it can never connect.
const DEAD_REDIS = 'redis://127.0.0.1:6390';

test('no REDIS_URL means no Redis client', () => {
  assert.equal(createRedis(''), null);
  assert.equal(createRedis(undefined), null);
});

test('/health reports redis:true when Redis answers', async (t) => {
  const redis = await setupTestRedis(t);
  const { base, close } = await listen(createApp({ db: fakeDb, auth: fakeAuth, redis }));
  t.after(close);
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.redis, true);
});

test('/health reports redis:false when Redis is configured but unreachable', async (t) => {
  const redis = createRedis(DEAD_REDIS, { log: quietLog });
  t.after(() => redis.disconnect());
  const { base, close } = await listen(createApp({ db: fakeDb, auth: fakeAuth, redis }));
  t.after(close);
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.redis, false);
});

test('an outage is logged once however many retries fail, and the recovery once', async (t) => {
  const warnings = [];
  const redis = createRedis(DEAD_REDIS, { log: { warn: (m) => warnings.push(m) } });
  t.after(() => redis.disconnect());
  await settle(700); // the client retries at 200 ms, 400 ms, ... and each attempt fails
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Redis unavailable/);
  redis.emit('ready'); // what the client emits when a retry finally connects
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Redis reconnected/);
});
