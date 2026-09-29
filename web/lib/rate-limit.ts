// What to tell someone the server refused for going too fast. The server sends
// 'rate-limited' { event } for these; extra captions are dropped silently instead.
const MESSAGES: Record<string, string> = {
  'chat:message': 'You’re sending messages too fast. Wait a moment, then try again.',
  'meeting:join-request': 'Too many join attempts. Wait a moment, then try again.',
  'screen:request': 'Wait a moment before sharing your screen again.',
  host: 'Slow down: wait a moment before the next host action.',
};

export function rateLimitMessage(event: string): string {
  return MESSAGES[event] ?? 'You’re doing that too fast. Wait a moment, then try again.';
}

// socket.io never retries a connection the server's middleware refused, so when the
// server's connection limit names a wait, the client retries itself after it (at
// least a second). Any other connect_error is null: socket.io handles those.
export function connectRetryDelay(err: unknown): number | null {
  const wait = (err as { data?: { retryAfterMs?: unknown } } | null)?.data?.retryAfterMs;
  return typeof wait === 'number' && Number.isFinite(wait) ? Math.max(1000, wait) : null;
}
