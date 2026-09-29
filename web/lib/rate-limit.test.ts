import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRetryDelay, rateLimitMessage } from './rate-limit.ts';

test('each refused event gets its own wording', () => {
  assert.match(rateLimitMessage('chat:message'), /messages too fast/);
  assert.match(rateLimitMessage('meeting:join-request'), /join attempts/);
  assert.match(rateLimitMessage('screen:request'), /sharing your screen/);
  assert.match(rateLimitMessage('host'), /host action/);
});

test('an event without its own wording gets the general one', () => {
  assert.match(rateLimitMessage('something-new'), /too fast/);
});

test('a refused connection is retried after the wait the server named, at least a second', () => {
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 3000 } }), 3000);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 200 } }), 1000);
});

test('other connection errors are left to socket.io', () => {
  assert.equal(connectRetryDelay(new Error('Sign in required.')), null);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 'soon' } }), null);
  assert.equal(connectRetryDelay(null), null);
});
