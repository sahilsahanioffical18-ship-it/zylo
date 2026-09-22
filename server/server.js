require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { createApp } = require('./app');
const { createDb } = require('./lib/db');
const { createLivekit } = require('./lib/livekit');
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

  if (db) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
      // A crash leaves meetings marked live; in-memory seats did not survive it.
      await closeStaleMeetings(db);
    } catch (err) {
      console.warn(`WARNING: could not apply db/schema.sql (${err.message}). Is Postgres running? Try: npm run db:up`);
    }
  }

  const app = createApp({ db, auth: clerkAuth({ db }), livekit });
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });
  io.use(clerkSocketAuth({ db }));
  if (db) registerRoomHandlers(io, { db, livekit });
  else console.warn('WARNING: DATABASE_URL is not set — ZyloRoom sockets will refuse every join request.');

  httpServer.listen(PORT, () => console.log(`Zylo API listening on :${PORT}`));
}

main();
