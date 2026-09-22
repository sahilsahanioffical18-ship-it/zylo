'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { Loader2 } from 'lucide-react';
import { Notice, PreJoin } from '@/components/pre-join';
import { RoomShell } from '@/components/room-shell';
import { WaitingCard } from '@/components/waiting-card';
import { brand } from '@/lib/brand';
import type { MeetingCard } from '@/lib/types';
import { useLiveKitRoom, type MediaPrefs } from '@/lib/use-livekit-room';
import { useMeeting, type DeniedReason } from '@/lib/use-meeting';

// Module-level so it's a stable reference — allocating a fresh object per render
// would needlessly re-run any effect that has it in a dependency array.
const MEDIA_OFF: MediaPrefs = Object.freeze({ micOn: false, camOn: false });

const DENIED_COPY: Record<DeniedReason, { title: string; text: string }> = {
  not_found: {
    title: 'Meeting not found',
    text: 'This meeting doesn’t exist or the host cancelled it.',
  },
  ended: {
    title: 'This meeting has ended',
    text: `You can find it under ${brand.meet} → Previous on your dashboard.`,
  },
  removed: {
    title: 'You were removed from this meeting',
    text: 'The host removed you, so you can’t rejoin this one. Any other meeting still works.',
  },
  denied: {
    title: 'The host didn’t let you in',
    text: `Ask them for a new invite if you think this was a mistake, then open the ${brand.room} link again.`,
  },
};

export function MeetingRoomFlow({ code }: { code: string }) {
  const router = useRouter();
  const { user } = useUser();
  const [joined, setJoined] = useState<{ meeting: MeetingCard; prefs: MediaPrefs } | null>(null);
  // Set by handleLeave, checked only in the `!joined` branch below: it exists
  // purely to stop <PreJoin> mounting (and calling getUserMedia) during the
  // window between setJoined(null) and router.push('/dashboard') landing.
  const [leaving, setLeaving] = useState(false);
  // The socket only opens once Join is pressed, so nobody takes a seat while
  // they are still setting up their camera.
  const {
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
  } = useMeeting(joined ? code : null);
  const selfUserId = user?.id ?? '';
  const presenting = sharerUserId !== null && sharerUserId === selfUserId;
  // One expression decides both "which screen" and "is LiveKit connected", so they
  // can never disagree. `joined` is deliberately part of this condition, not
  // redundant with `state.status`: it is the only thing Leave changes
  // synchronously. use-meeting.ts's join effect opens with `if (!meetingId) return;`
  // *before* it would ever reset `state` — so when Leave fires, `state.status` is
  // still 'admitted' on the very next render, and dropping `joined` from this
  // expression would leave LiveKit connected (and still publishing) under a
  // <PreJoin> that believes it's starting fresh. Seat lost any other way -> a real
  // socket event flips `state.status` itself (denied/replaced/offline) -> this
  // still goes to null -> the connect effect's cleanup runs -> room.disconnect().
  // A transient socket blip is NOT one of these paths: use-meeting.ts only flips
  // state away from 'admitted' on connect_error, not on a bare 'disconnect', so a
  // reconnecting socket keeps video up.
  const media = useLiveKitRoom(joined && state.status === 'admitted' ? code : null, joined?.prefs ?? MEDIA_OFF, {
    grant: shareGrant,
    allowed: presenting,
    onEnded: stopScreen,
  });

  // Tells the server first (releases the seat), then tears down locally right
  // away rather than waiting on a socket round-trip: setting joined to null
  // unmounts useMeeting's effect (disconnects the socket) and — because `joined`
  // is part of the gate above — flips useLiveKitRoom's meeting id to null on this
  // same render, so its connect effect's cleanup (room.disconnect()) is queued
  // before <PreJoin> ever mounts and re-acquires the camera.
  function handleLeave() {
    setLeaving(true);
    leave();
    setJoined(null);
    router.push('/dashboard');
  }

  if (!joined) {
    // leaving: render nothing rather than <PreJoin> — otherwise the brief window
    // before router.push('/dashboard') lands would mount PreJoin, which fetches
    // the meeting and calls getUserMedia, blinking the camera light back on (and
    // flashing "This meeting has ended" if this was the last participant out).
    if (leaving) return null;
    return <PreJoin code={code} onJoin={(meeting, prefs) => setJoined({ meeting, prefs })} />;
  }

  if (state.status === 'denied') {
    const { title, text } = DENIED_COPY[state.reason];
    return <Notice title={title} text={text} />;
  }
  if (state.status === 'replaced') {
    return (
      <Notice
        title="You joined from another tab or device"
        text={`Only one ${brand.room} connection per person stays open. Close the other one and open this link again if you want to come back here.`}
      />
    );
  }
  if (state.status === 'offline') {
    return (
      <Notice
        title={`Can’t reach the ${brand.product} server`}
        text="Check that it’s running, then open this link again. Reconnecting happens on its own if it comes back."
      />
    );
  }
  if (state.status === 'connecting') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3" role="status">
        <Loader2 className="size-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-muted-foreground">Connecting to {brand.room}…</p>
      </main>
    );
  }
  if (state.status === 'waiting') {
    return <WaitingCard manual={state.manual} position={state.position} onLeave={handleLeave} />;
  }

  return (
    <RoomShell
      title={joined.meeting.title}
      maxParticipants={joined.meeting.maxParticipants}
      people={state.people}
      lobby={lobby}
      admission={admission ?? joined.meeting.admission}
      isHost={state.people.find((p) => p.userId === user?.id)?.isHost ?? false}
      selfUserId={selfUserId}
      media={media}
      sharerUserId={sharerUserId}
      onToggleLive={presenting ? media.stopScreenShare : requestScreen}
      onAdmit={admitFromLobby}
      onDeny={denyFromLobby}
      onSetAdmission={setAdmissionMode}
      onLeave={handleLeave}
      messages={messages}
      onSendChat={sendChat}
    />
  );
}
