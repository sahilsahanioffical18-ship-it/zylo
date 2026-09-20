'use client';

import { useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ChatPanel } from '@/components/chat-panel';
import { PeoplePanel } from '@/components/people-panel';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import type { Admission } from '@/lib/types';
import type { ChatMessage, LobbyEntry, Person } from '@/lib/use-meeting';

type PanelTab = 'chat' | 'people';

// Phase 2 has no media: a tile is an initials circle. VideoStage replaces this in
// Phase 3, and the mic / camera / ZyloLive / ZyloChat controls arrive with it.
function Tile({ person }: { person: Person }) {
  return (
    <div className="relative grid aspect-video place-items-center rounded-2xl border border-border bg-card">
      <span className="grid size-20 place-items-center rounded-full bg-muted text-2xl font-bold text-muted-foreground">
        {initials(person.name)}
      </span>
      <span className="absolute inset-x-3 bottom-3 flex items-center gap-2">
        <span className="truncate rounded-md bg-background/80 px-2 py-1 text-sm font-medium">{person.name}</span>
        {person.isHost && <Badge variant="secondary">Host</Badge>}
      </span>
    </div>
  );
}

export function RoomShell({
  title,
  maxParticipants,
  people,
  lobby,
  admission,
  isHost,
  onAdmit,
  onDeny,
  onSetAdmission,
  onLeave,
  messages,
  sendChat,
}: {
  title: string;
  maxParticipants: number;
  people: Person[];
  lobby: LobbyEntry[];
  admission: Admission;
  isHost: boolean;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onSetAdmission: (mode: Admission) => void;
  onLeave: () => void;
  messages: ChatMessage[];
  sendChat: (text: string) => void;
}) {
  const { user } = useUser();
  const [tab, setTab] = useState<PanelTab>('people'); // People is the default: the host's
  // lobby (admit/deny) and the admission setting live there, and hiding those behind a
  // tab would regress Phase 2 behaviour.
  const [sheetOpen, setSheetOpen] = useState(false);

  const peoplePanel = (
    <PeoplePanel
      people={people}
      lobby={lobby}
      admission={admission}
      isHost={isHost}
      onAdmit={onAdmit}
      onDeny={onDeny}
      onSetAdmission={onSetAdmission}
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
        <ChatPanel messages={messages} selfUserId={user?.id ?? ''} onSend={sendChat} />
      </TabsContent>
      <TabsContent value="people" className="min-h-0 flex-1">
        {peoplePanel}
      </TabsContent>
    </Tabs>
  );
  const waitingCount = isHost ? lobby.length : 0;

  // ZyloRoom is always dark, whatever the dashboard's theme is set to.
  return (
    <div className="dark flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate font-semibold">{title}</h1>
        <Badge variant="outline" className="tabular-nums">
          {people.length}/{maxParticipants}
        </Badge>
        {isHost && <Badge variant="outline">{admission === 'manual' ? 'Host admits' : 'Join instantly'}</Badge>}
      </header>

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <main
          aria-label={`${brand.room} stage`}
          className="grid min-h-0 flex-1 auto-rows-max content-center grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3"
        >
          {people.map((person) => (
            <Tile key={person.userId} person={person} />
          ))}
        </main>
        <aside aria-label="Chat and people" className="hidden w-80 shrink-0 lg:block">
          {panel}
        </aside>
      </div>

      <footer className="flex items-center justify-center gap-3 border-t border-border px-4 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="relative size-12 rounded-full lg:hidden"
              aria-label={`People (${people.length})`}
              onClick={() => setSheetOpen(true)}
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
        {/* Controlled, no SheetTrigger: Task 10's control bar opens this too, so the
            footer button above just flips the same `sheetOpen` state. */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="dark w-full max-w-sm p-4">
            <SheetHeader className="p-0 pb-4">
              <SheetTitle>Chat and people</SheetTitle>
            </SheetHeader>
            {panel}
          </SheetContent>
        </Sheet>

        <Button variant="destructive" className="h-12 rounded-full px-6" onClick={onLeave}>
          Leave
        </Button>
      </footer>
    </div>
  );
}
