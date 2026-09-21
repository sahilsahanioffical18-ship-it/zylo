'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { SERVER_URL } from '@/lib/api';
import { brand } from '@/lib/brand';
import { validateChatText } from '@/lib/chat-rules';
import type { Admission } from '@/lib/types';

export type Person = { userId: string; name: string; imageUrl: string | null; isHost: boolean };
export type LobbyEntry = { userId: string; name: string; imageUrl: string | null };
export type DeniedReason = 'not_found' | 'ended' | 'removed' | 'denied';
export type ChatMessage = { userId: string; name: string; text: string; ts: number };

// ponytail: keep the last 200 in memory; nothing is stored anyway, so scrollback has a
// floor. Raise it or virtualise if a long meeting ever loses history people wanted.
const MAX_MESSAGES = 200;

export type MeetingState =
  | { status: 'connecting' }
  | { status: 'offline' }
  | { status: 'waiting'; position: number; manual: boolean }
  | { status: 'admitted'; people: Person[] }
  | { status: 'denied'; reason: DeniedReason }
  | { status: 'replaced' };

type AdmitAck = { ok: boolean; reason?: 'full' | 'gone' };

/**
 * Joins a ZyloRoom over Socket.IO. Pass `null` while the user is still on the
 * pre-join screen: no socket opens, so nobody takes a seat before pressing Join.
 */
export function useMeeting(meetingId: string | null) {
  const { getToken } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [state, setState] = useState<MeetingState>({ status: 'connecting' });
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!meetingId) return;
    // Deferred a tick so this reset isn't a synchronous setState-in-effect
    // (matches the async-callback pattern the rest of this codebase uses).
    Promise.resolve().then(() => {
      setState({ status: 'connecting' });
      setLobby([]);
      setMessages([]);
    });

    const socket = io(SERVER_URL, {
      // The callback form runs again on every reconnect, so the server always
      // gets a fresh short-lived Clerk token instead of an expired one.
      auth: (cb) => {
        getToken().then((token) => cb({ token: token ?? '' }));
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => socket.emit('meeting:join-request', { meetingId }));
    // The server is down or the token was refused. Never dress this up as a
    // missing meeting — socket.io keeps retrying, and 'connect' recovers us.
    socket.on('connect_error', () => setState({ status: 'offline' }));
    socket.on('meeting:waiting', ({ position, manual }: { position: number; manual: boolean }) =>
      setState({ status: 'waiting', position, manual }),
    );
    // room:presence always follows meeting:admitted and carries the roster, so it
    // is what flips us into the room — admitted on its own would render empty.
    socket.on('room:presence', ({ people }: { people: Person[] }) => setState({ status: 'admitted', people }));
    socket.on('meeting:denied', ({ reason }: { reason: DeniedReason }) => {
      setState({ status: 'denied', reason });
      // Terminal screen: nothing to reconnect to. Calling disconnect() here is a
      // CLIENT-initiated disconnect, which is what turns off socket.io's automatic
      // reconnection (this is not a 'disconnect' event LISTENER — we still never
      // react to the server's own disconnect event, which the 30s seat grace
      // period depends on). Without this call, a later network blip would
      // reconnect this socket, re-emit meeting:join-request, and silently
      // re-queue someone the host just denied.
      socket.disconnect();
    });
    socket.on('meeting:replaced', () => {
      setState({ status: 'replaced' });
      // Same fix as meeting:denied above. Without disconnecting here, a hidden
      // tab's socket that blips (laptop sleep, background-tab throttling) would
      // reconnect, re-send join-request, skip the lobby (the server lets a seat
      // holder back in without queueing), retake the seat from the tab the user
      // is actually watching, and flip back to 'admitted' — republishing camera
      // and mic from a tab nobody is looking at.
      socket.disconnect();
    });
    socket.on('lobby:update', ({ waiting }: { waiting: LobbyEntry[] }) => setLobby(waiting));
    socket.on('meeting:settings', (settings: { admission: Admission }) => setAdmission(settings.admission));
    socket.on('chat:message', (m: ChatMessage) => setMessages((prev) => [...prev, m].slice(-MAX_MESSAGES)));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meetingId, getToken]);

  const leave = useCallback(() => {
    socketRef.current?.emit('meeting:leave');
  }, []);

  const admitFromLobby = useCallback((userId: string) => {
    socketRef.current?.emit('lobby:admit', { userId }, (ack?: AdmitAck) => {
      if (!ack || ack.ok) return;
      toast.error(ack.reason === 'full' ? `${brand.room} is full.` : 'They already left the lobby.');
    });
  }, []);

  const denyFromLobby = useCallback((userId: string) => {
    socketRef.current?.emit('lobby:deny', { userId });
  }, []);

  const setAdmissionMode = useCallback((mode: Admission) => {
    socketRef.current?.emit('host:set-admission', { mode });
  }, []);

  // Validate client-side so a message the server would silently drop never leaves
  // the browser (the server takes the sender's name from the seat, so there is
  // nothing else for this call to pass).
  const sendChat = useCallback((text: string) => {
    if (validateChatText(text) === null) return;
    socketRef.current?.emit('chat:message', { text });
  }, []);

  return { state, lobby, admission, messages, leave, admitFromLobby, denyFromLobby, setAdmissionMode, sendChat };
}
