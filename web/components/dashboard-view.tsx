'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { toast } from 'sonner';
import { MeetingsSection } from '@/components/meetings-section';
import { useApi } from '@/lib/api';
import type { Dashboard } from '@/lib/types';

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardView() {
  const api = useApi();
  const { user } = useUser();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Dashboard>('/dashboard');
      setDashboard(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, [api]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time fetch on mount; state updates happen after an await, not synchronously
    void load();
  }, [load]);

  const cancelMeeting = useCallback(
    async (id: string) => {
      try {
        await api(`/meetings/${id}`, { method: 'DELETE' });
        toast.success('Meeting cancelled');
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not cancel the meeting.');
      }
    },
    [api, load],
  );

  const now = new Date();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        {/* Local time and name differ between server render and browser */}
        <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl" suppressHydrationWarning>
          {greeting(now.getHours())}
          {user?.firstName ? `, ${user.firstName}` : ''}
        </h2>
        <p className="text-muted-foreground" suppressHydrationWarning>
          {new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now)}
        </p>
      </div>

      {/* ACTION-ROW */}

      <MeetingsSection
        dashboard={dashboard}
        error={error}
        onRetry={() => {
          setError(null);
          setDashboard(null);
          void load();
        }}
        onCancel={cancelMeeting}
      />
    </div>
  );
}
