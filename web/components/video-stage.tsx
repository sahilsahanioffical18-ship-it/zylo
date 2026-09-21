'use client';

import { useEffect, useRef } from 'react';
import type { RemoteAudioTrack, VideoTrack } from 'livekit-client';
import { MicOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import type { LiveKitStatus } from '@/lib/use-livekit-room';
import type { Person } from '@/lib/use-meeting';

// The RoomAudioRenderer replacement we took on by declining @livekit/components-react:
// one hidden <audio> per subscribed remote audio track. Never `muted` (that would
// silence the room) and never given the local track (that would cause echo).
// Keyed by track sid at the call site so a real track change remounts this and
// re-runs the attach effect, while an unrelated snapshot update does not.
function AudioSink({ track }: { track: RemoteAudioTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return <audio ref={ref} autoPlay playsInline />;
}

function Tile({
  person,
  isSelf,
  track,
  isSpeaking,
  isMicMuted,
}: {
  person: Person;
  isSelf: boolean;
  track: VideoTrack | undefined;
  isSpeaking: boolean;
  isMicMuted: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div
      className={`relative grid aspect-video place-items-center overflow-hidden rounded-2xl border border-border bg-card transition-[box-shadow] duration-200 ${
        isSpeaking ? 'ring-2 ring-success' : ''
      }`}
    >
      {/* Roster is the source of truth: the tile exists whether or not `track` has
          arrived yet, so a slow or failed media connection still shows the avatar
          instead of an empty stage. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={isSelf}
        className={`size-full object-cover ${isSelf ? '-scale-x-100' : ''} ${track ? '' : 'hidden'}`}
      />
      {!track && (
        <span className="grid size-20 place-items-center rounded-full bg-muted text-2xl font-bold text-muted-foreground">
          {initials(person.name)}
        </span>
      )}
      <span className="absolute inset-x-3 bottom-3 flex items-center gap-2">
        <span className="truncate rounded-md bg-background/80 px-2 py-1 text-sm font-medium">{person.name}</span>
        {person.isHost && <Badge variant="secondary">Host</Badge>}
        {isMicMuted && <MicOff className="size-4 shrink-0 text-muted-foreground" aria-label="Muted" />}
      </span>
    </div>
  );
}

export function VideoStage({
  people,
  selfUserId,
  videoTracks,
  audioTracks,
  speaking,
  micMuted,
  status,
}: {
  people: Person[];
  selfUserId: string;
  videoTracks: Map<string, VideoTrack>;
  audioTracks: { sid: string; track: RemoteAudioTrack }[];
  speaking: Set<string>;
  micMuted: Set<string>;
  status: LiveKitStatus;
}) {
  return (
    <>
      <main
        aria-label={`${brand.room} stage`}
        className="grid min-h-0 flex-1 auto-rows-max content-center grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3"
      >
        {status === 'connecting' && (
          <p role="status" className="col-span-full text-center text-sm text-muted-foreground">
            Connecting video…
          </p>
        )}
        {people.map((person) => (
          <Tile
            key={person.userId}
            person={person}
            isSelf={person.userId === selfUserId}
            track={videoTracks.get(person.userId)}
            isSpeaking={speaking.has(person.userId)}
            isMicMuted={micMuted.has(person.userId)}
          />
        ))}
      </main>
      {/* display:none removes this from flex/grid layout entirely, so it never
          introduces a phantom gap in the row RoomShell lays VideoStage out in. */}
      <div className="hidden">
        {audioTracks.map(({ sid, track }) => (
          <AudioSink key={sid} track={track} />
        ))}
      </div>
    </>
  );
}
