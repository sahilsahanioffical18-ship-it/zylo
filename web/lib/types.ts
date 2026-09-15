export type MeetingStatus = 'scheduled' | 'live' | 'ended';
export type Admission = 'auto' | 'manual';
export type ScreenSharePolicy = 'anyone' | 'host_only';

export interface MeetingCard {
  id: string;
  title: string;
  status: MeetingStatus;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  admission: Admission;
  screenSharePolicy: ScreenSharePolicy;
  maxParticipants: number;
  host: { name: string };
  isHost: boolean;
  participants: { name: string; imageUrl: string | null }[];
}

export interface Dashboard {
  live: MeetingCard[];
  upcoming: MeetingCard[];
  previous: MeetingCard[];
}

export interface CreateMeetingInput {
  title?: string;
  scheduledFor?: string;
  admission?: Admission;
  screenSharePolicy?: ScreenSharePolicy;
  maxParticipants?: number;
  inviteEmails?: string[];
}
