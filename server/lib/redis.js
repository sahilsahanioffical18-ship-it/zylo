const Redis = require('ioredis');

// The one Redis connection. While Redis is down, commands fail at once (no offline
// queue, one try, a 500 ms timeout) so every caller falls back immediately instead
// of hanging; the client keeps reconnecting in the background, backing off to 5 s.
// ponytail: one log line per outage and one per recovery, never per command. Add a
// metric if you ever need to know how often it happens.
function createRedis(url = process.env.REDIS_URL, { log = console } = {}) {
  if (!url) return null;
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  let down = false;
  redis.on('error', (err) => {
    if (down) return;
    down = true;
    log.warn(`Redis unavailable (${err.message}). Falling back until it returns.`);
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    log.warn('Redis reconnected.');
  });
  return redis;
}

// Resolves once the connection is usable. With no offline queue a command sent
// before this rejects, so tests (and anything that must not start degraded) wait here.
function whenReady(redis) {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    redis.once('ready', resolve);
    redis.once('end', () => reject(new Error('Redis connection ended before it was ready')));
  });
}

module.exports = { createRedis, whenReady };
