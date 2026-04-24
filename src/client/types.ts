export type SessionUser = {
  email: string;
  id: number;
  name: string;
};

export type ScheduleItem = {
  booked: number;
  capacity: number;
  conflict: boolean;
  durationMin: number;
  id: number;
  openSlots: number;
  attendeeName: string;
  hostName: string;
  room: string;
  startsAt: string;
  status: string;
};

export type WaitlistItem = {
  createdAt: string;
  id: number;
  notes: string;
  attendeeName: string;
  phone: string;
  preferredWindowEnd: string;
  preferredWindowStart: string;
  requestedHost: string;
  score: number;
  status: string;
  urgency: string;
};

export type SuggestionItem = {
  sessionId: number;
  sessionAttendeeName: string;
  attendeeName: string;
  hostName: string;
  score: number;
  waitlistId: number;
  windowLabel: string;
};

export type CheckInItem = {
  sessionId: number;
  arrivalState: string;
  checkedInAt: string | null;
  deskNote: string;
  attendeeName: string;
  hostName: string;
  room: string;
  startsAt: string;
};

export type DashboardData = {
  checkInBoard: CheckInItem[];
  metrics: {
    escalations: number;
    openSlots: number;
    todaySessions: number;
    waitlistCount: number;
  };
  schedule: ScheduleItem[];
  suggestions: SuggestionItem[];
  waitlist: WaitlistItem[];
};
