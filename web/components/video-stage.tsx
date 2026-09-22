'use client';

import { useEffect, useRef } from 'react';
import type { RemoteAudioTrack, VideoTrack } from 'livekit-client';
import { MicOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import { presentingBanner, type StageView } from '@/lib/screen-share';
import type { LiveKitStatus } from '@/lib/use-livekit-room';
import type { Person } from '@/lib/use-meeting';

// attach()/detach() in an effect keyed on the track: one copy for every media element here.
function useAttach<E extends HTMLMediaElement>(track: VideoTrack | RemoteAudioTrack | undefined) {
  const ref = useRef<E | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return ref;
}

// object-contain: a shared screen is mostly text, so letterbox it, never crop it.
// muted: its audio, if shared, plays through AudioSink like every other track.
function ScreenVideo({ track }: { track: VideoTrack }) {
  const ref = useAttach<HTMLVideoElement>(track);
  return <video ref={ref} autoPlay playsInline muted className="size-full object-contain" />;
}

// The RoomAudioRenderer replacement we took on by declining @livekit/components-react:
// one hidden <audio> per subscribed remote audio track. Never `muted` (that would
// silence the room) and never given the local track (that would cause echo).
// Keyed by track sid at the call site so a real track change remounts this and
// re-runs the attach effect, while an unrelated snapshot update does not.
function AudioSink({ track }: { track: RemoteAudioTrack }) {
  const ref = useAttach<HTMLAudioElement>(track);
  return <audio ref={ref} autoPlay playsInline />;
}

function Tile({
  person,
  isSelf,
  track,
  isSpeaking,
  isMicMuted,
  compact,
}: {
  person: Person;
  isSelf: boolean;
  track: VideoTrack | undefined;
  isSpeaking: boolean;
  isMicMuted: boolean;
  compact?: boolean;
}) {
  const ref = useAttach<HTMLVideoElement>(track);

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
        <span
          className={`grid place-items-center rounded-full bg-muted font-bold text-muted-foreground ${
            compact ? 'size-10 text-base' : 'size-20 text-2xl'
          }`}
        >
          {initials(person.name)}
        </span>
      )}
      <span className={`absolute flex items-center gap-2 ${compact ? 'inset-x-2 bottom-2 text-xs' : 'inset-x-3 bottom-3'}`}>
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
  view,
  screenTracks,
}: {
  people: Person[];
  selfUserId: string;
  videoTracks: Map<string, VideoTrack>;
  audioTracks: { sid: string; track: RemoteAudioTrack }[];
  speaking: Set<string>;
  micMuted: Set<string>;
  status: LiveKitStatus;
  view: StageView;
  screenTracks: Map<string, VideoTrack>;
}) {
  const tileProps = (person: Person) => ({
    person,
    isSelf: person.userId === selfUserId,
    track: videoTracks.get(person.userId),
    isSpeaking: speaking.has(person.userId),
    isMicMuted: micMuted.has(person.userId),
  });

  // display:none removes this from flex/grid layout entirely, so it never
  // introduces a phantom gap in the row RoomShell lays VideoStage out in.
  const audioSinks = (
    <div className="hidden">
      {audioTracks.map(({ sid, track }) => (
        <AudioSink key={sid} track={track} />
      ))}
    </div>
  );

  if (view.mode === 'presenting') {
    const screen = view.isSelf ? undefined : screenTracks.get(view.sharerUserId);
    return (
      <>
        {/* min-w-0: the filmstrip scrolls inside itself; the page never scrolls sideways. */}
        <main aria-label={`${brand.room} stage`} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <p role="status" className="rounded-lg bg-success px-4 py-2 text-sm font-semibold text-success-foreground">
            {presentingBanner(view, brand.live)}
          </p>
          <div className="grid min-h-0 flex-1 place-items-center overflow-hidden rounded-2xl border border-border bg-card">
            {view.isSelf ? (
              <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
                Everyone can see your screen. Press {brand.live} in the controls when you’re done.
              </p>
            ) : screen ? (
              <ScreenVideo track={screen} />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for {view.sharerName}’s screen…
              </p>
            )}
          </div>
          <ul aria-label="People" className="flex shrink-0 gap-3 overflow-x-auto pb-1">
            {people.map((person) => (
              <li key={person.userId} className="w-36 shrink-0 sm:w-44">
                <Tile {...tileProps(person)} compact />
              </li>
            ))}
          </ul>
        </main>
        {audioSinks}
      </>
    );
  }

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
          <Tile key={person.userId} {...tileProps(person)} />
        ))}
      </main>
      {audioSinks}
    </>
  );
}
