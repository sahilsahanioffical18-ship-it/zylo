'use client';

import { Check, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ADMISSION_OPTIONS, ChoiceGroup } from '@/components/choice-group';
import { initials } from '@/lib/format';
import type { Admission } from '@/lib/types';
import type { LobbyEntry, Person } from '@/lib/use-meeting';

function PersonAvatar({ name, imageUrl }: { name: string; imageUrl: string | null }) {
  return (
    <Avatar className="size-8">
      {imageUrl && <AvatarImage src={imageUrl} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

function LobbyAction({
  label,
  icon: Icon,
  variant,
  onClick,
}: {
  label: string;
  icon: typeof Check;
  variant: 'secondary' | 'ghost';
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant={variant} className="size-9" aria-label={label} onClick={onClick}>
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function PeoplePanel({
  people,
  lobby,
  admission,
  isHost,
  onAdmit,
  onDeny,
  onSetAdmission,
}: {
  people: Person[];
  lobby: LobbyEntry[];
  admission: Admission;
  isHost: boolean;
  onAdmit: (userId: string) => void;
  onDeny: (userId: string) => void;
  onSetAdmission: (mode: Admission) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-4">
      {isHost && (
        <ChoiceGroup
          legend="Admission"
          name="room-admission"
          value={admission}
          onChange={onSetAdmission}
          options={ADMISSION_OPTIONS}
          className="grid gap-2"
        />
      )}

      {isHost && lobby.length > 0 && (
        <section aria-label="Waiting to join" className="space-y-2">
          <h2 className="text-sm font-semibold tabular-nums">Waiting ({lobby.length})</h2>
          <ul className="space-y-1">
            {lobby.map((entry) => (
              <li key={entry.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                <PersonAvatar name={entry.name} imageUrl={entry.imageUrl} />
                <span className="flex-1 truncate text-sm">{entry.name}</span>
                <LobbyAction
                  label={`Admit ${entry.name}`}
                  icon={Check}
                  variant="secondary"
                  onClick={() => onAdmit(entry.userId)}
                />
                <LobbyAction
                  label={`Deny ${entry.name}`}
                  icon={X}
                  variant="ghost"
                  onClick={() => onDeny(entry.userId)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="People in the meeting" className="flex min-h-0 flex-1 flex-col space-y-2">
        <h2 className="text-sm font-semibold tabular-nums">In the meeting ({people.length})</h2>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1 pr-3">
            {people.map((person) => (
              <li key={person.userId} className="flex items-center gap-3 rounded-lg px-1 py-1.5">
                <PersonAvatar name={person.name} imageUrl={person.imageUrl} />
                <span className="flex-1 truncate text-sm">{person.name}</span>
                {person.isHost && <Badge variant="secondary">Host</Badge>}
              </li>
            ))}
          </ul>
        </ScrollArea>
      </section>
    </div>
  );
}
