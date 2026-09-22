'use client';

import { FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Admission, ScreenSharePolicy } from '@/lib/types';

// One copy of the admission and ZyloLive wording for the schedule dialog and the
// in-room people panel, so the two can never drift apart.
export const ADMISSION_OPTIONS: { value: Admission; label: string; hint: string }[] = [
  { value: 'auto', label: 'Join instantly', hint: 'People enter until the room is full.' },
  { value: 'manual', label: 'Host admits', hint: 'People wait in the lobby for you.' },
];

export const SCREEN_POLICY_OPTIONS: { value: ScreenSharePolicy; label: string; hint: string }[] = [
  { value: 'anyone', label: 'Anyone', hint: 'One presenter at a time.' },
  { value: 'host_only', label: 'Host only', hint: 'Only you can present.' },
];

export function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  className = 'grid gap-2 sm:grid-cols-2',
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint: string }[];
  className?: string;
}) {
  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className={className}>
        {options.map((option) => (
          <Label
            key={option.value}
            htmlFor={`${name}-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors duration-150 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-accent"
          >
            <RadioGroupItem id={`${name}-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block font-semibold">{option.label}</span>
              <span data-hint className="block text-xs font-normal text-muted-foreground">{option.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}
