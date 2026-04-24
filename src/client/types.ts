export type SessionUser = {
  email: string;
  id: number;
  name: string;
  role: string;
};

export type ScheduleItem = {
  attendeePreview: string[];
  bookedCount: number;
  capacity: number;
  checkedInCount: number;
  conflict: boolean;
  durationMin: number;
  hostName: string;
  id: number;
  openSeats: number;
  room: string;
  startsAt: string;
  status: string;
  statusLabel: string;
  title: string;
  track: string;
  waitlistDemand: number;
};

export type WaitlistItem = {
  attendeeName: string;
  attendeePhone: string;
  createdAt: string;
  id: number;
  notes: string;
  preferredWindowEnd: string;
  preferredWindowStart: string;
  requestedHost: string;
  requestedSessionId: number | null;
  requestedSessionTitle: string | null;
  score: number;
  status: string;
  urgency: string;
};

export type SuggestionItem = {
  attendeeName: string;
  hostName: string;
  reason: string;
  requestedSessionTitle: string | null;
  score: number;
  sessionId: number;
  sessionTitle: string;
  waitlistId: number;
  windowLabel: string;
};

export type CheckInItem = {
  arrivalState: string;
  attendeeName: string;
  bookingId: number;
  checkedInAt: string | null;
  deskNote: string;
  hostName: string;
  releaseReason: string;
  room: string;
  seatStatus: string;
  sessionId: number;
  sessionTitle: string;
  startsAt: string;
};

export type DashboardData = {
  checkInBoard: CheckInItem[];
  metrics: {
    checkedInCount: number;
    openSeats: number;
    todaySessions: number;
    waitlistCount: number;
  };
  schedule: ScheduleItem[];
  suggestions: SuggestionItem[];
  waitlist: WaitlistItem[];
};

export type BookingResponse = {
  attendeeName: string;
  dashboard: DashboardData;
  outcome: "booked" | "waitlisted";
  sessionTitle: string;
};
