'use client';

import { useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { Loader2 } from 'lucide-react';
import { Notice, PreJoin } from '@/components/pre-join';
import { RoomShell } from '@/components/room-shell';
import { WaitingCard } from '@/components/waiting-card';
import { brand } from '@/lib/brand';
import type { MeetingCard } from '@/lib/types';
import { useMeeting, type DeniedReason } from '@/lib/use-meeting';

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
  const { user } = useUser();
  const [meeting, setMeeting] = useState<MeetingCard | null>(null);
  // The socket only opens once Join is pressed, so nobody takes a seat while
  // they are still setting up their camera.
  const { state, lobby, admission, leave, admitFromLobby, denyFromLobby, setAdmissionMode } = useMeeting(
    meeting ? code : null,
  );

  if (!meeting) return <PreJoin code={code} onJoin={(loaded) => setMeeting(loaded)} />;

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
    return <WaitingCard manual={state.manual} position={state.position} onLeave={leave} />;
  }

  return (
    <RoomShell
      title={meeting.title}
      maxParticipants={meeting.maxParticipants}
      people={state.people}
      lobby={lobby}
      admission={admission ?? meeting.admission}
      isHost={state.people.find((p) => p.userId === user?.id)?.isHost ?? false}
      onAdmit={admitFromLobby}
      onDeny={denyFromLobby}
      onSetAdmission={setAdmissionMode}
      onLeave={leave}
    />
  );
}
