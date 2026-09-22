'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChatPanel } from '@/components/chat-panel';
import { ControlBar, type PanelTab } from '@/components/control-bar';
import { PeoplePanel } from '@/components/people-panel';
import { VideoStage } from '@/components/video-stage';
import { brand } from '@/lib/brand';
import { stageView } from '@/lib/screen-share';
import type { Admission, ScreenSharePolicy } from '@/lib/types';
import type { useLiveKitRoom } from '@/lib/use-livekit-room';
import type { ChatMessage, LobbyEntry, Person } from '@/lib/use-meeting';

export function RoomShell({
  title,
  maxParticipants,
  people,
  lobby,
  admission,
  isHost,
  selfUserId,
  media,
  sharerUserId,
  screenPolicy,
  onSetScreenPolicy,
  onToggleLive,
  onAdmit,
  onDeny,
  onSetAdmission,
  onMute,
  onStopShare,
  onKick,
  onLeave,
  onEndForAll,
  messages,
  onSendChat,
}: {
  title: string;
  maxParticipants: number;
  people: Person[];
  lobby: LobbyEntry[];
  admission: Admission;
  isHost: boolean;
  selfUserId: string;
  media: ReturnType<typeof useLiveKitRoom>;
  sharerUserId: string | null;
  screenPolicy: ScreenSharePolicy;
  onSetScreenPolicy: (policy: ScreenSharePolicy) => void;
  onToggleLive: () => void;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onSetAdmission: (mode: Admission) => void;
  onMute: (userId: string) => void;
  onStopShare: (userId: string) => void;
  onKick: (userId: string) => void;
  onLeave: () => void;
  onEndForAll: () => void;
  messages: ChatMessage[];
  onSendChat: (text: string) => void;
}) {
  const view = stageView(sharerUserId, selfUserId, people);
  const [tab, setTab] = useState<PanelTab>('people'); // People is the default: the host's
  // lobby (admit/deny) and the admission setting live there, and hiding those behind a
  // tab would regress Phase 2 behaviour.
  const [sheetOpen, setSheetOpen] = useState(false);

  const openPanel = (next: PanelTab) => {
    setTab(next);
    // The panel is docked at >=1024px; below that the same button opens the Sheet.
    // Reading the media query in the click handler (not during render) keeps this
    // out of hydration and out of react-hooks' way.
    if (!window.matchMedia('(min-width: 1024px)').matches) setSheetOpen(true);
  };

  const peoplePanel = (
    <PeoplePanel
      people={people}
      lobby={lobby}
      admission={admission}
      isHost={isHost}
      selfUserId={selfUserId}
      sharerUserId={sharerUserId}
      micMuted={media.micMuted}
      screenPolicy={screenPolicy}
      onSetScreenPolicy={onSetScreenPolicy}
      onAdmit={onAdmit}
      onDeny={onDeny}
      onSetAdmission={onSetAdmission}
      onMute={onMute}
      onStopShare={onStopShare}
      onKick={onKick}
    />
  );

  const panel = (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as PanelTab)}
      className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card p-4"
    >
      <TabsList className="w-full">
        <TabsTrigger value="chat">{brand.chat}</TabsTrigger>
        <TabsTrigger value="people">People ({people.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="chat" className="min-h-0 flex-1">
        <ChatPanel messages={messages} selfUserId={selfUserId} onSend={onSendChat} />
      </TabsContent>
      <TabsContent value="people" className="min-h-0 flex-1">
        {peoplePanel}
      </TabsContent>
    </Tabs>
  );
  const waitingCount = isHost ? lobby.length : 0;

  // ZyloRoom is always dark, whatever the dashboard's theme is set to.
  return (
    <div className="dark flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
        <Badge variant="outline" className="tabular-nums">
          {people.length}/{maxParticipants}
        </Badge>
        {isHost && (
          // cn() drops the badge's base inline-flex in favour of `hidden` (checked).
          <Badge variant="outline" className="hidden sm:inline-flex">
            {admission === 'manual' ? 'Host admits' : 'Join instantly'}
          </Badge>
        )}
      </header>

      {media.status === 'error' && (
        // Non-blocking, above the stage: losing video must not eject anyone from a
        // meeting whose chat, presence and lobby run over an independent transport.
        <p role="alert" className="mx-4 mt-3 rounded-lg border border-warning bg-card px-4 py-3 text-sm">
          {media.error} <Button variant="ghost" size="sm" onClick={media.retry}>Try again</Button>
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <VideoStage
          people={people}
          selfUserId={selfUserId}
          videoTracks={media.videoTracks}
          audioTracks={media.audioTracks}
          speaking={media.speaking}
          micMuted={media.micMuted}
          status={media.status}
          view={view}
          screenTracks={media.screenTracks}
        />
        <aside aria-label="Chat and people" className="hidden w-80 shrink-0 lg:block">
          {panel}
        </aside>
      </div>

      {/* Controlled, no SheetTrigger: ControlBar's Chat/People buttons open this too
          (via openPanel), so they just flip the same `sheetOpen` state. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="dark w-full max-w-sm p-4">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Chat and people</SheetTitle>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>

      <ControlBar
        micOn={media.micOn}
        camOn={media.camOn}
        onToggleMic={media.toggleMic}
        onToggleCam={media.toggleCam}
        mediaReady={media.status === 'connected'}
        sharing={sharerUserId !== null && sharerUserId === selfUserId}
        onToggleLive={onToggleLive}
        peopleCount={people.length}
        waitingCount={waitingCount}
        onOpenPanel={openPanel}
        onLeave={onLeave}
        isHost={isHost}
        onEndForAll={onEndForAll}
      />
    </div>
  );
}
