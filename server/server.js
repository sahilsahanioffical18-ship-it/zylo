require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createApp } = require('./app');
const { createDb } = require('./lib/db');
const { createLivekit } = require('./lib/livekit');
const { createRedis } = require('./lib/redis');
const { createLimiter } = require('./lib/rateLimit');
const { createRoomStore } = require('./lib/roomStore');
const { limitConnections } = require('./lib/limitMiddleware');
const { createCache, createRedisCache } = require('./lib/cache');
const { clerkAuth, clerkSocketAuth } = require('./lib/auth');
const { registerRoomHandlers } = require('./lib/room');

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';

async function main() {
  const db = createDb(process.env.DATABASE_URL);
  if (!db) console.warn('WARNING: DATABASE_URL is not set — /api routes will return 503.');
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    console.warn('WARNING: CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY are not set — /api routes will return 503.');
  }
  const livekit = createLivekit();
  if (!livekit) {
    console.warn(
      'WARNING: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set — the LiveKit token route will return 503.',
    );
  }
  const redis = createRedis();
  if (!redis) console.warn("WARNING: REDIS_URL is not set — rate limits and the translation cache stay in this server's memory.");
  const limiter = createLimiter({ redis });
  // One id per process: seats and the screen lock record which server holds them.
  const store = redis ? createRoomStore(redis, { serverId: randomUUID() }) : null;
  // Proxy hops to trust for the client IP: a non-negative integer, else 0 (a bad value must not silently pass).
  const rawTrust = (process.env.TRUST_PROXY || '').trim();
  const validTrust = /^\d+$/.test(rawTrust);
  const trustProxy = validTrust ? Number(rawTrust) : 0;
  if (rawTrust && !validTrust) console.warn(`WARNING: TRUST_PROXY="${rawTrust}" is not a non-negative integer — using 0.`);

  if (db) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
    } catch (err) {
      console.warn(`WARNING: could not apply db/schema.sql (${err.message}). Is Postgres running? Try: npm run db:up`);
    }
  }

  const app = createApp({
    db, auth: clerkAuth({ db }), livekit, redis, limiter, trustProxy, store,
    google: { cache: redis ? createRedisCache(redis) : createCache() },
  });
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });
  if (redis) {
    // Two connections of its own with the offline queue on: the adapter subscribes at
    // start-up and must not fail just because Redis isn't connected yet. duplicate()
    // copies redis.js's 500 ms commandTimeout / 1 s socketTimeout, which would fail
    // that first subscribe, so both are cleared. redis.js already reports outages, so
    // their errors are not logged again.
    const pubSubOptions = { enableOfflineQueue: true, maxRetriesPerRequest: null, commandTimeout: undefined, socketTimeout: undefined };
    const pub = redis.duplicate(pubSubOptions);
    const sub = redis.duplicate(pubSubOptions);
    pub.on('error', () => {});
    sub.on('error', () => {});
    io.adapter(createAdapter(pub, sub));
  }
  io.use(limitConnections(limiter, trustProxy)); // before auth: a flood never reaches token checks
  io.use(clerkSocketAuth({ db }));
  if (db && store) registerRoomHandlers(io, { db, livekit, store });
  else {
    console.warn('WARNING: DATABASE_URL or REDIS_URL is not set — ZyloRoom sockets will refuse every join request.');
    // Refuse out loud: with no handler a client would wait on "connecting" for good.
    io.on('connection', (socket) =>
      socket.on('meeting:join-request', () => socket.emit('meeting:denied', { reason: 'unavailable' })),
    );
  }

  httpServer.listen(PORT, () => console.log(`Zylo API listening on :${PORT}`));
}

main();
