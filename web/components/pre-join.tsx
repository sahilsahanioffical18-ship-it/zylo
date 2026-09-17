'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { CalendarX, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ZyloLogo } from '@/components/zylo-logo';
import { ApiError, useApi } from '@/lib/api';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import type { MeetingCard } from '@/lib/types';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; meeting: MeetingCard }
  | { status: 'error'; notFound: boolean; message: string };

type Props = { code: string; onJoin?: (prefs: { micOn: boolean; camOn: boolean }) => void };

function mediaErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Camera and microphone are blocked. Allow them in your browser’s site settings, then reload.';
  if (name === 'NotFoundError') return 'No camera or microphone found. You can still join with them off.';
  if (name === 'NotReadableError') return 'Your camera or microphone is in use by another app.';
  return `This browser can’t use a camera on this page. Open ${brand.product} over HTTPS or on localhost.`;
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <ZyloLogo href="/dashboard" />
      <span className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground">
        <CalendarX className="size-7" aria-hidden="true" />
      </span>
      <div className="space-y-2">
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        <p className="max-w-md text-muted-foreground">{text}</p>
      </div>
      <Button asChild className="h-11 px-6">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </main>
  );
}

function ToggleButton({
  on,
  label,
  onIcon: OnIcon,
  offIcon: OffIcon,
  disabled,
  onClick,
}: {
  on: boolean;
  label: string;
  onIcon: typeof Mic;
  offIcon: typeof Mic;
  disabled: boolean;
  onClick: () => void;
}) {
  const text = `${on ? 'Turn off' : 'Turn on'} ${label}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant={on ? 'secondary' : 'destructive'}
          className="size-12 rounded-full"
          aria-label={text}
          aria-pressed={on}
          disabled={disabled}
          onClick={onClick}
        >
          {on ? <OnIcon className="size-5" /> : <OffIcon className="size-5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

export function PreJoin({ code, onJoin }: Props) {
  const api = useApi();
  const { user } = useUser();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api<{ meeting: MeetingCard; isHost: boolean }>(`/meetings/${code}`)
      .then(({ meeting }) => {
        if (!cancelled) setLoad({ status: 'ready', meeting });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: 'error',
          notFound: err instanceof ApiError && err.status === 404,
          message: err instanceof Error ? err.message : 'Could not load this meeting.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api, code]);

  // Only ask for the camera once the meeting exists and can still be joined.
  const canPreview = load.status === 'ready' && load.meeting.status !== 'ended';

  useEffect(() => {
    if (!canPreview) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    // Wrapped in a promise so a missing mediaDevices API becomes a normal rejection.
    Promise.resolve()
      .then(() => navigator.mediaDevices.getUserMedia({ video: true, audio: true }))
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired = media;
        setStream(media);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMediaError(mediaErrorMessage(err));
        setMicOn(false);
        setCamOn(false);
      });
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((t) => t.stop());
    };
  }, [canPreview]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  function toggle(kind: 'audio' | 'video') {
    if (!stream) return;
    const next = kind === 'audio' ? !micOn : !camOn;
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    tracks.forEach((t) => (t.enabled = next));
    if (kind === 'audio') setMicOn(next);
    else setCamOn(next);
  }

  if (load.status === 'error' && load.notFound) {
    return <Notice title="Meeting not found" text="This meeting doesn’t exist or the host cancelled it." />;
  }
  if (load.status === 'ready' && load.meeting.status === 'ended') {
    return <Notice title="This meeting has ended" text={`You can find it under ${brand.meet} → Previous on your dashboard.`} />;
  }

  const name = user?.fullName ?? user?.firstName ?? '';
  const meeting = load.status === 'ready' ? load.meeting : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center px-4 py-4 sm:px-6">
        <ZyloLogo href="/dashboard" />
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 px-4 pb-12 sm:px-6 lg:grid-cols-[1.4fr_1fr]">
        <section aria-label="Camera preview" className="space-y-3">
          <div className="dark relative aspect-video overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`size-full -scale-x-100 object-cover ${stream && camOn ? '' : 'hidden'}`}
            />
            {!(stream && camOn) && (
              <div className="absolute inset-0 grid place-items-center">
                <span className="grid size-24 place-items-center rounded-full bg-muted text-3xl font-bold text-muted-foreground">
                  {initials(name)}
                </span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-4 flex justify-center gap-3">
              <ToggleButton on={micOn} label="microphone" onIcon={Mic} offIcon={MicOff} disabled={!stream} onClick={() => toggle('audio')} />
              <ToggleButton on={camOn} label="camera" onIcon={Video} offIcon={VideoOff} disabled={!stream} onClick={() => toggle('video')} />
            </div>
          </div>
          {mediaError && (
            <p role="alert" className="rounded-lg border border-warning bg-card px-4 py-3 text-sm">
              {mediaError}
            </p>
          )}
        </section>

        <Card>
          <CardContent className="space-y-6 p-6">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-primary">{brand.room}</p>
              {meeting ? (
                <>
                  <h1 className="text-2xl font-extrabold tracking-tight text-balance">{meeting.title}</h1>
                  <p className="text-muted-foreground">
                    {meeting.isHost ? 'You are the host' : `Hosted by ${meeting.host.name}`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">
                      {meeting.admission === 'manual' ? 'Host admits each person' : 'Join instantly'}
                    </Badge>
                    <Badge variant="outline">
                      {brand.live}: {meeting.screenSharePolicy === 'host_only' ? 'host only' : 'anyone'}
                    </Badge>
                    <Badge variant="outline" className="tabular-nums">
                      Up to {meeting.maxParticipants} people
                    </Badge>
                  </div>
                </>
              ) : load.status === 'error' ? (
                <p role="alert" className="text-destructive">{load.message}</p>
              ) : (
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-8 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )}
            </div>

            <p className="text-sm text-muted-foreground">
              Joining as <span className="font-semibold text-foreground">{name}</span>
            </p>

            <div className="space-y-2">
              <Button
                className="h-12 w-full text-base"
                disabled={!meeting || !onJoin}
                onClick={() => onJoin?.({ micOn, camOn })}
              >
                Join {brand.room}
              </Button>
              {!onJoin && (
                <p className="text-center text-sm text-muted-foreground">
                  Joining a {brand.room} arrives with admission and seats (Phase 2).
                </p>
              )}
            </div>

            <Button asChild variant="ghost" className="h-11 w-full">
              <Link href="/dashboard">Back to dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
