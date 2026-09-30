require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { createApp } = require('./app');
const { createDb } = require('./lib/db');
const { createLivekit } = require('./lib/livekit');
const { createRedis } = require('./lib/redis');
const { createLimiter } = require('./lib/rateLimit');
const { limitConnections } = require('./lib/limitMiddleware');
const { createCache, createRedisCache } = require('./lib/cache');
const { clerkAuth, clerkSocketAuth } = require('./lib/auth');
const { registerRoomHandlers, closeStaleMeetings } = require('./lib/room');

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
  // Proxy hops to trust for the client IP: a non-negative integer, else 0 (a bad value must not silently pass).
  const rawTrust = (process.env.TRUST_PROXY || '').trim();
  const validTrust = /^\d+$/.test(rawTrust);
  const trustProxy = validTrust ? Number(rawTrust) : 0;
  if (rawTrust && !validTrust) console.warn(`WARNING: TRUST_PROXY="${rawTrust}" is not a non-negative integer — using 0.`);

  if (db) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
      // A crash leaves meetings marked live; in-memory seats did not survive it.
      await closeStaleMeetings(db);
    } catch (err) {
      console.warn(`WARNING: could not apply db/schema.sql (${err.message}). Is Postgres running? Try: npm run db:up`);
    }
  }

  const app = createApp({
    db, auth: clerkAuth({ db }), livekit, redis, limiter, trustProxy,
    google: { cache: redis ? createRedisCache(redis) : createCache() },
  });
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });
  io.use(limitConnections(limiter, trustProxy)); // before auth: a flood never reaches token checks
  io.use(clerkSocketAuth({ db }));
  if (db) registerRoomHandlers(io, { db, livekit });
  else console.warn('WARNING: DATABASE_URL is not set — ZyloRoom sockets will refuse every join request.');

  httpServer.listen(PORT, () => console.log(`Zylo API listening on :${PORT}`));
}

main();
