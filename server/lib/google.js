const express = require('express');
const { isConvoLang, takeToken, MAX_CAPTION_LENGTH } = require('./captionRules');
const { createCache } = require('./cache');

// Translator Convo's free online helpers, both Google's unkeyed web endpoints:
//
// - GET /tts: a voice for languages a device can't speak (macOS Chrome has none
//   for Marathi, Gujarati, Malayalam or Urdu).
// - GET /translate: the online translation when the browser has no on-device
//   translator. It replaced MyMemory as the first online choice because MyMemory's
//   crowd-sourced memory answered everyday sentences with spam (en→de "Hello, how
//   are you today?" came back as a Scarface plot summary); MyMemory is now only
//   the client's backup.
//
// ponytail: unofficial endpoints: free and covering all 18 languages, but Google
// can rate-limit or change them at any time. Every failure is a 502 the client
// falls back from (MyMemory for text, captions only for voice). Upgrade path: a
// self-hosted LibreTranslate / Piper behind these same routes.

const MAX_TTS_TEXT = 200; // Google refuses longer text; the client splits at 180
const UPSTREAM_TIMEOUT_MS = 5000;
const GOOGLE_LANG = { zh: 'zh-CN' }; // every other Zylo code is already Google's
const googleLang = (code) => GOOGLE_LANG[code] ?? code;
// A browser UA; there is deliberately NO Referer: Google's TTS answers 404 to
// requests that carry one (checked 2026-09-24), and Node's fetch sends none.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// Upstream budgets. A convo needs well under one call a second per person (one
// translation plus a voice clip or two per sentence), so a user gets 2/s with a
// burst of 10; the whole server gets 20/s, so no one user, or a buggy client loop,
// can get the server's IP rate-limited by Google for everyone.
const USER_RATE = 2;
const USER_BURST = 10;
const GLOBAL_RATE = 20;
const GLOBAL_BURST = 40;

const cleanText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// null on any failure: timeout, network, an error status, or the wrong kind of body.
async function fetchUpstreamBody(fetchUpstream, url, isExpected = () => true) {
  try {
    const res = await fetchUpstream(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    // A captcha or error page can come back as HTML with a 200: check the type too.
    if (!res.ok || !isExpected(res.headers.get('content-type') ?? '')) return null;
    return res;
  } catch {
    return null;
  }
}

async function fetchGoogleVoice(fetchUpstream, lang, text) {
  const query = new URLSearchParams({ ie: 'UTF-8', client: 'tw-ob', tl: googleLang(lang), q: text });
  const res = await fetchUpstreamBody(fetchUpstream, `https://translate.google.com/translate_tts?${query}`, (t) => t.startsWith('audio/'));
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

async function fetchGoogleTranslation(fetchUpstream, from, to, text) {
  const query = new URLSearchParams({ client: 'gtx', sl: googleLang(from), tl: googleLang(to), dt: 't', q: text });
  const res = await fetchUpstreamBody(fetchUpstream, `https://translate.googleapis.com/translate_a/single?${query}`);
  if (!res) return null;
  try {
    // [[[translated, original, ...], ...one per sentence], ...]. A captcha page fails
    // to parse here, and an empty result is '': the route treats both as a 502.
    const sentences = (await res.json())[0];
    return Array.isArray(sentences) ? sentences.map((s) => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : '')).join('').trim() : '';
  } catch {
    return null;
  }
}

function googleRouter({ fetchUpstream = fetch, cache = createCache(), now = Date.now } = {}) {
  const router = express.Router();
  // One budget per user for BOTH routes, plus one for the whole server, spent only
  // on upstream calls: a cache hit costs Google nothing. ponytail: in-process Maps,
  // never pruned (a few bytes per user who ever asked); move to Redis with the
  // cache in Phase 7.
  const buckets = new Map();
  let serverBucket = null;
  const allowUpstream = (userId) => {
    const t = now();
    if (!buckets.has(userId)) buckets.set(userId, { tokens: USER_BURST, at: t });
    serverBucket ??= { tokens: GLOBAL_BURST, at: t };
    // The user's own budget first, so one user over theirs never spends the server's.
    return takeToken(buckets.get(userId), t, USER_RATE, USER_BURST) && takeToken(serverBucket, t, GLOBAL_RATE, GLOBAL_BURST);
  };

  router.get('/tts', async (req, res, next) => {
    try {
      const { lang } = req.query;
      const text = cleanText(req.query.text);
      if (!isConvoLang(lang) || !text || text.length > MAX_TTS_TEXT) {
        return res.status(400).json({ error: 'Need a supported lang and 1–200 characters of text.' });
      }

      const key = `tts\n${lang}\n${text}`;
      let audio = await cache.get(key);
      const hit = audio !== null;
      if (!hit) {
        if (!allowUpstream(req.userId)) return res.status(429).json({ error: 'Too many requests. Slow down.' });
        audio = await fetchGoogleVoice(fetchUpstream, lang, text);
        if (!audio) return res.status(502).json({ error: 'The online voice is unavailable right now.' });
        await cache.set(key, audio);
      }

      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'X-Cache': hit ? 'HIT' : 'MISS' });
      res.send(audio);
    } catch (err) {
      next(err);
    }
  });

  router.get('/translate', async (req, res, next) => {
    try {
      const { from, to } = req.query;
      const text = cleanText(req.query.text);
      if (!isConvoLang(from) || !isConvoLang(to) || from === to || !text || text.length > MAX_CAPTION_LENGTH) {
        return res.status(400).json({ error: 'Need two different supported languages and 1–500 characters of text.' });
      }

      const key = `tr\n${from}>${to}\n${text}`;
      let translated = await cache.get(key);
      const hit = translated !== null;
      if (!hit) {
        if (!allowUpstream(req.userId)) return res.status(429).json({ error: 'Too many requests. Slow down.' });
        translated = await fetchGoogleTranslation(fetchUpstream, from, to, text);
        if (!translated) return res.status(502).json({ error: 'Online translation is unavailable right now.' });
        await cache.set(key, translated);
      }

      res.set({ 'Cache-Control': 'private, max-age=86400', 'X-Cache': hit ? 'HIT' : 'MISS' });
      res.json({ text: translated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { googleRouter, MAX_TTS_TEXT, USER_BURST, GLOBAL_BURST };
