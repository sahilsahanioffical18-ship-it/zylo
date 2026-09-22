'use client';

import { MessageSquare, Mic, MicOff, ScreenShare, ScreenShareOff, Users, Video, VideoOff } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MediaToggle } from '@/components/media-toggle';
import { brand } from '@/lib/brand';

export type PanelTab = 'chat' | 'people';

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
  isHost,
  onEndForAll,
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
  isHost: boolean;
  onEndForAll: () => void;
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

      {isHost && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="h-12 rounded-full px-6">
              End for all
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="dark">
            <AlertDialogHeader>
              <AlertDialogTitle>End this meeting for everyone?</AlertDialogTitle>
              <AlertDialogDescription>
                Everyone is disconnected, including you. It moves to {brand.meet} → Previous.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep meeting</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onEndForAll}>
                End for all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </footer>
  );
}
