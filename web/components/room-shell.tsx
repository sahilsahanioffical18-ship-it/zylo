'use client';

import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PeoplePanel } from '@/components/people-panel';
import { brand } from '@/lib/brand';
import { initials } from '@/lib/format';
import type { Admission } from '@/lib/types';
import type { LobbyEntry, Person } from '@/lib/use-meeting';

// Phase 2 has no media: a tile is an initials circle. VideoStage replaces this in
// Phase 3, and the mic / camera / ZyloLive / ZyloChat controls arrive with it.
function Tile({ person }: { person: Person }) {
  return (
    <div className="relative grid min-h-40 place-items-center rounded-2xl border border-border bg-card">
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
}) {
  const panel = (
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
          className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {people.map((person) => (
            <Tile key={person.userId} person={person} />
          ))}
        </main>
        <aside aria-label="People" className="hidden w-80 shrink-0 lg:block">
          {panel}
        </aside>
      </div>

      <footer className="flex items-center justify-center gap-3 border-t border-border px-4 py-3">
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="relative size-12 rounded-full lg:hidden"
                  aria-label={`People (${people.length})`}
                >
                  <Users className="size-5" />
                  {waitingCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 grid size-5 place-items-center rounded-full bg-primary text-xs font-bold tabular-nums text-primary-foreground">
                      {waitingCount}
                    </span>
                  )}
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent>People</TooltipContent>
          </Tooltip>
          <SheetContent side="right" className="dark w-full max-w-sm p-4">
            <SheetHeader className="p-0 pb-4">
              <SheetTitle>People</SheetTitle>
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
