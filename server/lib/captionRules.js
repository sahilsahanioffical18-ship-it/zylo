// Twin of web/lib/convo-languages.ts — the two lists must name the same codes;
// test/convoLangs.test.js fails if they drift.

const CONVO_LANGS = Object.freeze([
  'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'ur', 'en', 'ru', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'pt',
]);

function isConvoLang(x) {
  return typeof x === 'string' && CONVO_LANGS.includes(x);
}

const ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_CAPTION_LENGTH = 500;
const MAX_TRANSLATION_LENGTH = 1000;

// Twin of chatRules' validateChatText, but for the convo:caption payload. A bad
// translation attachment drops only the attachment, not the caption — the
// caption is the thing that actually needs to arrive; the translation is a
// bonus the receiver can also produce itself.
function validateCaption(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const { id, text, lang, final, translation } = payload;

  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_CAPTION_LENGTH) return null;
  if (!isConvoLang(lang)) return null;
  if (typeof final !== 'boolean') return null;

  const clean = { id, text: trimmed, lang, final };
  const cleanTranslation = validateTranslation(translation);
  if (cleanTranslation) clean.translation = cleanTranslation;
  return clean;
}

function validateTranslation(translation) {
  if (typeof translation !== 'object' || translation === null) return null;
  const { lang, text } = translation;
  if (!isConvoLang(lang)) return null;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TRANSLATION_LENGTH) return null;
  return { lang, text: trimmed };
}

// The first rate limit in Zylo. Captions need one where chat didn't: a client
// throttles interim results to ~4/s but that's a courtesy, not a guarantee, and
// Socket.IO enforces no size or rate limit of its own (chatRules' MAX_CHAT_LENGTH
// is the only other guard, and it caps size, not frequency).
//
// A token bucket: refills at RATE tokens/second up to BURST, spends 1 per call.
const RATE = 8;
const BURST = 12;

// ponytail: in memory, per socket (bucket lives on socket.data), so a
// reconnect gets a fresh bucket — fine at 2 seats. Move it to Redis alongside
// seats.js in Phase 7 if abuse across reconnects becomes a real problem.
function takeToken(bucket, now, rate = RATE, burst = BURST) {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

const allowCaption = (bucket, now) => takeToken(bucket, now);

module.exports = {
  CONVO_LANGS,
  isConvoLang,
  MAX_CAPTION_LENGTH,
  MAX_TRANSLATION_LENGTH,
  validateCaption,
  allowCaption,
  takeToken,
  RATE,
  BURST,
};
