'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { brand } from '@/lib/brand';
import { MAX_CHAT_LENGTH, validateChatText } from '@/lib/chat-rules';
import type { ChatMessage } from '@/lib/use-meeting';

// Counter only shows once someone is close to the ceiling — no need to clutter the
// composer for the other 95% of messages.
const SHOW_COUNTER_AT = MAX_CHAT_LENGTH - 100;

function Bubble({ message, own }: { message: ChatMessage; own: boolean }) {
  const time = new Date(message.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <li className={cn('flex', own ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          // Not --secondary: that indigo tint is reserved for AI bubbles later.
          own ? 'bg-muted' : 'border border-border',
        )}
      >
        {!own && <p className="text-xs font-semibold">{message.name}</p>}
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <p className="mt-1 text-right text-[10px] text-muted-foreground tabular-nums">{time}</p>
      </div>
    </li>
  );
}

export function ChatPanel({
  messages,
  selfUserId,
  onSend,
}: {
  messages: ChatMessage[];
  selfUserId: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // DOM write, not a setState — lint-clean under react-hooks/set-state-in-effect.
  useEffect(() => {
    const viewport = containerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [messages.length]);

  function send() {
    if (validateChatText(draft) === null) return;
    onSend(draft);
    setDraft('');
  }

  const disabled = validateChatText(draft) === null;

  return (
    <div className="flex h-full flex-col gap-3">
      <div ref={containerRef} className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <p role="status" className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
            No messages yet. {brand.chat} isn&apos;t saved, so messages disappear when the meeting ends.
          </p>
        ) : (
          <ScrollArea className="h-full">
            <ul className="space-y-2 pr-3">
              {messages.map((message, i) => (
                <Bubble key={`${message.userId}-${message.ts}-${i}`} message={message} own={message.userId === selfUserId} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={MAX_CHAT_LENGTH}
          placeholder={`Message ${brand.chat}`}
          aria-label={brand.chat}
          className="max-h-32 resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          {draft.length > SHOW_COUNTER_AT && (
            <span className="mr-auto text-xs tabular-nums text-muted-foreground">
              {draft.length}/{MAX_CHAT_LENGTH}
            </span>
          )}
          <Button type="button" size="sm" onClick={send} disabled={disabled}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
