const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCaption,
  allowCaption,
  MAX_CAPTION_LENGTH,
  MAX_TRANSLATION_LENGTH,
  BURST,
  RATE,
} = require('../lib/captionRules');

const base = () => ({ id: 'abc-123', text: 'hello there', lang: 'hi', final: true });

test('a valid payload comes back clean', () => {
  assert.deepEqual(validateCaption(base()), { id: 'abc-123', text: 'hello there', lang: 'hi', final: true });
});

test('rejects a bad id', () => {
  for (const id of ['', 'UPPER', 'has spaces', 'x'.repeat(33), 'emoji-🙂', 42, null, undefined]) {
    assert.equal(validateCaption({ ...base(), id }), null, JSON.stringify(id));
  }
});

test('rejects empty or whitespace-only text', () => {
  for (const text of ['', '   ', '\n\t ']) {
    assert.equal(validateCaption({ ...base(), text }), null, JSON.stringify(text));
  }
});

test('rejects text over 500 characters (after trimming), accepts exactly 500', () => {
  assert.equal(validateCaption({ ...base(), text: 'x'.repeat(MAX_CAPTION_LENGTH + 1) }), null);
  assert.equal(validateCaption({ ...base(), text: 'x'.repeat(MAX_CAPTION_LENGTH) }).text.length, MAX_CAPTION_LENGTH);
  // trimmed length is what's measured
  assert.equal(validateCaption({ ...base(), text: '  ' + 'x'.repeat(MAX_CAPTION_LENGTH) + '  ' }).text.length, MAX_CAPTION_LENGTH);
});

test('rejects a bad lang', () => {
  for (const lang of ['xx', '', 'HI', 42, null, undefined]) {
    assert.equal(validateCaption({ ...base(), lang }), null, JSON.stringify(lang));
  }
});

test('rejects final that is not a real boolean', () => {
  for (const final of ['true', 'false', 1, 0, null, undefined]) {
    assert.equal(validateCaption({ ...base(), final }), null, JSON.stringify(final));
  }
  assert.ok(validateCaption({ ...base(), final: false }));
});

test('rejects non-object input', () => {
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    assert.equal(validateCaption(bad), null, String(bad));
  }
});

test('strips unknown keys', () => {
  const clean = validateCaption({ ...base(), evil: 'haxx0r', userId: 'forged', name: 'Impostor' });
  assert.deepEqual(Object.keys(clean).sort(), ['final', 'id', 'lang', 'text']);
});

test('drops only the translation when it is invalid, keeping the caption', () => {
  for (const translation of [
    { lang: 'xx', text: 'bad lang' },
    { lang: 'ru', text: '' },
    { lang: 'ru', text: '   ' },
    { lang: 'ru', text: 'x'.repeat(MAX_TRANSLATION_LENGTH + 1) },
    { lang: 'ru' }, // missing text
    { text: 'no lang' },
    'not an object',
    42,
  ]) {
    const clean = validateCaption({ ...base(), translation });
    assert.ok(clean, JSON.stringify(translation));
    assert.equal(clean.translation, undefined, JSON.stringify(translation));
  }
});

test('keeps a valid translation, trimmed', () => {
  const clean = validateCaption({ ...base(), translation: { lang: 'ru', text: '  привет  ' } });
  assert.deepEqual(clean.translation, { lang: 'ru', text: 'привет' });
});

test('accepts translation text at exactly 1000 characters', () => {
  const clean = validateCaption({ ...base(), translation: { lang: 'ru', text: 'x'.repeat(MAX_TRANSLATION_LENGTH) } });
  assert.equal(clean.translation.text.length, MAX_TRANSLATION_LENGTH);
});

test('allowCaption: a burst of 12 passes, the 13th fails', () => {
  const bucket = { tokens: BURST, at: 0 };
  for (let i = 0; i < BURST; i++) {
    assert.equal(allowCaption(bucket, 0), true, `token ${i}`);
  }
  assert.equal(allowCaption(bucket, 0), false);
});

test('allowCaption: refills at 8/s — 250ms buys back 2 tokens', () => {
  const bucket = { tokens: 0, at: 0 };
  assert.equal(allowCaption(bucket, 0), false);
  assert.equal(allowCaption(bucket, 250), true);
  assert.equal(allowCaption(bucket, 250), true);
  assert.equal(allowCaption(bucket, 250), false);
});

test('allowCaption: tokens never exceed BURST, even after a long idle', () => {
  const bucket = { tokens: BURST, at: 0 };
  assert.equal(allowCaption(bucket, 0), true); // burn one down to 11
  const farFuture = 1000 * RATE * 1000; // absurdly long idle
  for (let i = 0; i < BURST; i++) {
    assert.equal(allowCaption(bucket, farFuture), true, `token ${i}`);
  }
  assert.equal(allowCaption(bucket, farFuture), false);
});
