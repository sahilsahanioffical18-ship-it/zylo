require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { createDb } = require('./lib/db');
const { clerkAuth } = require('./lib/auth');

const PORT = Number(process.env.PORT) || 4000;

async function main() {
  const db = createDb(process.env.DATABASE_URL);
  if (!db) console.warn('WARNING: DATABASE_URL is not set — /api routes will return 503.');
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    console.warn('WARNING: CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY are not set — /api routes will return 503.');
  }

  if (db) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
    } catch (err) {
      console.warn(`WARNING: could not apply db/schema.sql (${err.message}). Is Postgres running? Try: npm run db:up`);
    }
  }

  const app = createApp({ db, auth: clerkAuth({ db }) });
  app.listen(PORT, () => console.log(`Zylo API listening on :${PORT}`));
}

main();
