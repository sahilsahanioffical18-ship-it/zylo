'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { SERVER_URL } from '@/lib/api';
import { brand } from '@/lib/brand';
import { validateChatText } from '@/lib/chat-rules';
import { screenDeniedMessage, type ScreenDenial } from '@/lib/screen-share';
import type { Admission, ScreenSharePolicy } from '@/lib/types';

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
  const [sharerUserId, setSharerUserId] = useState<string | null>(null);
  // Bumped once per screen:granted. A counter, not a flag — see use-livekit-room.ts's
  // capture effect for why.
  const [shareGrant, setShareGrant] = useState(0);
  const [screenPolicy, setScreenPolicy] = useState<ScreenSharePolicy | null>(null);

  useEffect(() => {
    if (!meetingId) return;
    // Deferred a tick so this reset isn't a synchronous setState-in-effect
    // (matches the async-callback pattern the rest of this codebase uses).
    Promise.resolve().then(() => {
      setState({ status: 'connecting' });
      setLobby([]);
      setMessages([]);
      setSharerUserId(null);
      setShareGrant(0);
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
    // Every terminal screen goes through here, so none of them can forget the
    // disconnect. Terminal screen: nothing to reconnect to. Calling disconnect() here is a
    // CLIENT-initiated disconnect, which is what turns off socket.io's automatic
    // reconnection (this is not a 'disconnect' event LISTENER — we still never
    // react to the server's own disconnect event, which the 30s seat grace
    // period depends on). Without this call, a later network blip would
    // reconnect this socket, re-emit meeting:join-request, and silently
    // re-queue someone the host just denied/removed/ended.
    const end = (reason: DeniedReason) => {
      setState({ status: 'denied', reason });
      socket.disconnect();
    };
    socket.on('meeting:denied', ({ reason }: { reason: DeniedReason }) => end(reason));
    // The spec's contract names: host:kick sends meeting:removed, End for all meeting:ended.
    socket.on('meeting:removed', () => end('removed'));
    socket.on('meeting:ended', () => end('ended'));
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
    socket.on('meeting:settings', (s: { admission: Admission; screenSharePolicy: ScreenSharePolicy }) => {
      setAdmission(s.admission);
      setScreenPolicy(s.screenSharePolicy);
    });
    socket.on('chat:message', (m: ChatMessage) => setMessages((prev) => [...prev, m].slice(-MAX_MESSAGES)));
    socket.on('screen:granted', () => setShareGrant((n) => n + 1));
    socket.on('screen:denied', (denial: ScreenDenial) => toast.error(screenDeniedMessage(denial, brand.live)));
    socket.on('screen:state', ({ sharerUserId: id }: { sharerUserId: string | null }) => setSharerUserId(id));

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
  // nothing else for this call to pass). Sends what it validated, not the raw
  // text, so a message that only differs by leading/trailing whitespace can't
  // reach the server untrimmed.
  const sendChat = useCallback((text: string) => {
    const clean = validateChatText(text);
    if (clean === null) return;
    socketRef.current?.emit('chat:message', { text: clean });
  }, []);

  const requestScreen = useCallback(() => {
    socketRef.current?.emit('screen:request');
  }, []);

  const stopScreen = useCallback(() => {
    socketRef.current?.emit('screen:stop');
  }, []);

  const kick = useCallback((userId: string) => {
    socketRef.current?.emit('host:kick', { userId });
  }, []);

  const mute = useCallback((userId: string) => {
    socketRef.current?.emit('host:mute', { userId });
  }, []);

  const stopShareOf = useCallback((userId: string) => {
    socketRef.current?.emit('host:stop-share', { userId });
  }, []);

  const setScreenPolicyMode = useCallback((policy: ScreenSharePolicy) => {
    socketRef.current?.emit('host:set-screen-policy', { policy });
  }, []);

  const endMeeting = useCallback(() => {
    socketRef.current?.emit('host:end-meeting', {});
  }, []);

  return {
    state,
    lobby,
    admission,
    messages,
    leave,
    admitFromLobby,
    denyFromLobby,
    setAdmissionMode,
    sendChat,
    sharerUserId,
    shareGrant,
    requestScreen,
    stopScreen,
    screenPolicy,
    kick,
    mute,
    stopShareOf,
    setScreenPolicyMode,
    endMeeting,
  };
}
