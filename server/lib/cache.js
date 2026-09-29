// Spoken-translation clips (MP3 bytes) keyed by language + text, so a phrase
// Google has already voiced ("hello", "thank you", "yes") is served from memory
// instead of fetched again.
//
// ponytail: in memory, one process, lost on restart. The async get/set is
// Redis-shaped on purpose: when Redis arrives in Phase 7 (seats move there too),
// this file becomes GET / SET key EX ttl and nothing that calls it changes.

const DAY_MS = 24 * 60 * 60 * 1000;

function createCache({ max = 500, ttlMs = DAY_MS, now = Date.now } = {}) {
  const entries = new Map(); // insertion order = least recently used first

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= now()) return null;
      entries.set(key, entry); // most recently used again
      return entry.audio;
    },
    async set(key, audio) {
      entries.delete(key);
      entries.set(key, { audio, expiresAt: now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}

module.exports = { createCache };
