'use client';

import { MessageSquare, Mic, MicOff, ScreenShare, ScreenShareOff, Users, Video, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MediaToggle } from '@/components/media-toggle';
import { brand } from '@/lib/brand';

export type PanelTab = 'chat' | 'people';

// No End-for-all button here — that's Phase 4's host controls (Task 10). This is
// Mic, Camera, ZyloLive, ZyloChat, People, Leave and nothing else.
export function ControlBar({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  mediaReady,
  sharing,
  onToggleLive,
  peopleCount,
  waitingCount,
  onOpenPanel,
  onLeave,
}: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  mediaReady: boolean;
  sharing: boolean;
  onToggleLive: () => void;
  peopleCount: number;
  waitingCount: number;
  onOpenPanel: (tab: PanelTab) => void;
  onLeave: () => void;
}) {
  return (
    <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-border px-4 py-3">
      <MediaToggle
        on={micOn}
        label="microphone"
        onIcon={Mic}
        offIcon={MicOff}
        disabled={!mediaReady}
        onClick={onToggleMic}
      />
      <MediaToggle
        on={camOn}
        label="camera"
        onIcon={Video}
        offIcon={VideoOff}
        disabled={!mediaReady}
        onClick={onToggleCam}
      />

      {/* Enabled whoever is presenting and whatever the policy: the server answers
          with the spec's toasts (busy / host_only / unavailable). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant={sharing ? 'default' : 'secondary'}
            className="size-12 rounded-full"
            aria-label={sharing ? `Stop ${brand.live}` : brand.live}
            aria-pressed={sharing}
            disabled={!mediaReady}
            onClick={onToggleLive}
          >
            {sharing ? <ScreenShareOff className="size-5" /> : <ScreenShare className="size-5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{sharing ? `Stop ${brand.live}` : `${brand.live} · share your screen`}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="size-12 rounded-full"
            aria-label={brand.chat}
            onClick={() => onOpenPanel('chat')}
          >
            <MessageSquare className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{brand.chat}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="relative size-12 rounded-full"
            aria-label={`People (${peopleCount})`}
            onClick={() => onOpenPanel('people')}
          >
            <Users className="size-5" />
            {waitingCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid size-5 place-items-center rounded-full bg-primary text-xs font-bold tabular-nums text-primary-foreground">
                {waitingCount}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>People</TooltipContent>
      </Tooltip>

      <Button variant="destructive" className="h-12 rounded-full px-6" onClick={onLeave}>
        Leave
      </Button>
    </footer>
  );
}
