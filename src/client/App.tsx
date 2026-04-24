import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import type {
  BookingResponse,
  CheckInItem,
  DashboardData,
  ScheduleItem,
  SessionUser,
  SuggestionItem,
  WaitlistItem,
} from "./types";

type SessionResponse = {
  user: SessionUser | null;
};

type BookingFormState = {
  attendeeName: string;
  notes: string;
  phone: string;
  requestedHost: string;
  sessionId: string;
  urgency: string;
};

type BookingSubmitState = Omit<BookingFormState, "sessionId"> & {
  sessionId: number;
};

const defaultBookingForm: BookingFormState = {
  attendeeName: "",
  notes: "",
  phone: "",
  requestedHost: "",
  sessionId: "",
  urgency: "medium",
};

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    void bootstrap();
  }, []);

  async function bootstrap() {
    try {
      const session = await api<SessionResponse>("/api/session");
      setUser(session.user);
      if (session.user) {
        setDashboard(await api<DashboardData>("/api/dashboard"));
      }
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setSessionChecked(true);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    const formData = new FormData(event.currentTarget);

    try {
      const response = await api<{ user: SessionUser }>("/api/login", {
        body: JSON.stringify({
          email: formData.get("email"),
          password: formData.get("password"),
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      setUser(response.user);
      setDashboard(await api<DashboardData>("/api/dashboard"));
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      await api("/api/logout", { method: "POST" });
      setDashboard(null);
      setUser(null);
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleBookingSubmit(state: BookingSubmitState): Promise<BookingResponse> {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      const response = await api<BookingResponse>("/api/bookings", {
        body: JSON.stringify(state),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      setDashboard(response.dashboard);
      setNotice(
        response.outcome === "booked"
          ? `${response.attendeeName} booked into ${response.sessionTitle}.`
          : `${response.sessionTitle} is full. ${response.attendeeName} was added to the rescue waitlist.`,
      );
      return response;
    } catch (nextError) {
      setError(toMessage(nextError));
      throw nextError;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleBackfill(suggestion: SuggestionItem) {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      const nextDashboard = await api<DashboardData>(
        `/api/sessions/${suggestion.sessionId}/backfill`,
        {
          body: JSON.stringify({ waitlistId: suggestion.waitlistId }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );

      setDashboard(nextDashboard);
      setNotice(
        `${suggestion.attendeeName} was moved from the waitlist into ${suggestion.sessionTitle}.`,
      );
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCheckInUpdate(item: CheckInItem, arrivalState: string) {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      const nextDashboard = await api<DashboardData>(
        `/api/bookings/${item.bookingId}/state`,
        {
          body: JSON.stringify({
            arrivalState,
            deskNote: item.deskNote,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );

      setDashboard(nextDashboard);
      setNotice(`${item.attendeeName} marked ${arrivalState} for ${item.sessionTitle}.`);
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReleaseSeat(item: CheckInItem) {
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      const nextDashboard = await api<DashboardData>(
        `/api/bookings/${item.bookingId}/release`,
        {
          body: JSON.stringify({
            releaseReason: `Released from ${item.sessionTitle} by the door desk.`,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );

      setDashboard(nextDashboard);
      setNotice(`Seat released for ${item.attendeeName}. Rescue suggestions refreshed.`);
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  const summary = useMemo(() => {
    if (!dashboard) {
      return [];
    }

    return [
      {
        label: "Today sessions",
        value: String(dashboard.metrics.todaySessions),
      },
      {
        label: "Open seats",
        value: String(dashboard.metrics.openSeats),
      },
      {
        label: "Checked in",
        value: String(dashboard.metrics.checkedInCount),
      },
      {
        label: "Waiting list",
        value: String(dashboard.metrics.waitlistCount),
      },
    ];
  }, [dashboard]);

  const bookableSessions = useMemo(
    () => (dashboard?.schedule ?? []).filter((session) => session.statusLabel !== "wrapped"),
    [dashboard],
  );

  if (!sessionChecked) {
    return (
      <Shell>
        <div className="empty-state">Loading SeatSprint…</div>
      </Shell>
    );
  }

  if (!user) {
    return (
      <Shell>
        <section className="hero-card login-card">
          <div>
            <p className="eyebrow">Nightshift 066</p>
            <h1>SeatSprint</h1>
            <p className="hero-copy">
              Dark-mode booking desk for workshops, pop-up events, and same-day rescue fills.
              Keep the calendar visible, keep open seats moving, and keep the door team on the
              same board as hosts.
            </p>
          </div>
          <form className="login-form" onSubmit={handleLogin}>
            <label>
              Email
              <input defaultValue="host@seatsprint.local" name="email" type="email" />
            </label>
            <label>
              Password
              <input defaultValue="nightshift066" name="password" type="password" />
            </label>
            <button disabled={isSubmitting} type="submit">
              {isSubmitting ? "Signing in…" : "Sign in to the booking desk"}
            </button>
            <p className="hint">
              Seeded host, door, and ops accounts all use the shared demo password.
            </p>
            {error ? <p className="error-banner">{error}</p> : null}
          </form>
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="topbar">
        <div>
          <p className="eyebrow">Nightshift operations</p>
          <h1>SeatSprint</h1>
          <p className="hero-copy compact">
            Calendar board, booking intake, rescue queue, and live door control for today&apos;s
            workshops.
          </p>
        </div>
        <div className="topbar-actions">
          <div className="user-chip">
            <span>{user.name}</span>
            <small>
              {user.role} · {user.email}
            </small>
          </div>
          <button
            className="ghost-button"
            disabled={isSubmitting}
            onClick={handleLogout}
            type="button"
          >
            Log out
          </button>
        </div>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}
      {notice ? <p className="notice-banner">{notice}</p> : null}

      <section className="stats-grid">
        {summary.map((item) => (
          <article className="stat-card" key={item.label}>
            <p>{item.label}</p>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="grid layout-grid">
        <Panel
          className="panel-wide"
          subtitle="Grouped by day so ops can see the board before touching anything else."
          title="Calendar-first session board"
        >
          <CalendarBoard schedule={dashboard?.schedule ?? []} />
        </Panel>

        <Panel
          subtitle="Choose a session and SeatSprint books immediately or auto-waitlists when it is full."
          title="Attendee booking desk"
        >
          <BookingDesk
            disabled={isSubmitting}
            onSubmit={handleBookingSubmit}
            sessions={bookableSessions}
          />
        </Panel>

        <Panel
          subtitle="Highest-value rescues for newly reopened seats and lightly-booked sessions."
          title="Rescue suggestions"
        >
          <SuggestionsList
            disabled={isSubmitting}
            onBackfill={handleBackfill}
            suggestions={dashboard?.suggestions ?? []}
          />
        </Panel>

        <Panel
          subtitle="Check attendees in, mark contact attempts, or release seats back to the board."
          title="Door-staff and host controls"
        >
          <CheckInBoard
            disabled={isSubmitting}
            items={dashboard?.checkInBoard ?? []}
            onRelease={handleReleaseSeat}
            onUpdate={handleCheckInUpdate}
          />
        </Panel>

        <Panel subtitle="Sorted by urgency, time window, and current rescue status." title="Waitlist queue">
          <WaitlistTable waitlist={dashboard?.waitlist ?? []} />
        </Panel>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="app-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="ambient ambient-c" />
      <div className="content">{children}</div>
    </main>
  );
}

function Panel({
  children,
  className,
  subtitle,
  title,
}: {
  children: ReactNode;
  className?: string;
  subtitle: string;
  title: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`.trim()}>
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function BookingDesk({
  disabled,
  onSubmit,
  sessions,
}: {
  disabled: boolean;
  onSubmit: (state: BookingSubmitState) => Promise<BookingResponse>;
  sessions: ScheduleItem[];
}) {
  const [formState, setFormState] = useState<BookingFormState>(defaultBookingForm);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (sessions.length === 0) {
      return;
    }

    if (!sessions.some((session) => String(session.id) === formState.sessionId)) {
      setFormState((current) => ({ ...current, sessionId: String(sessions[0].id) }));
    }
  }, [formState.sessionId, sessions]);

  const selectedSession = sessions.find(
    (session) => String(session.id) === formState.sessionId,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);

    if (!formState.attendeeName || !formState.phone || !formState.sessionId) {
      setLocalError("Session, attendee name, and phone are required.");
      return;
    }

    try {
      await onSubmit({
        attendeeName: formState.attendeeName,
        notes: formState.notes,
        phone: formState.phone,
        requestedHost: formState.requestedHost,
        sessionId: Number(formState.sessionId),
        urgency: formState.urgency,
      });

      setFormState((current) => ({
        ...current,
        attendeeName: "",
        notes: "",
        phone: "",
        requestedHost: "",
      }));
    } catch {
      // surfaced globally
    }
  }

  if (sessions.length === 0) {
    return <div className="empty-state">No bookable sessions are loaded right now.</div>;
  }

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <div className="field-grid">
        <label>
          Preferred session
          <select
            onChange={(event) =>
              setFormState((current) => ({ ...current, sessionId: event.target.value }))
            }
            value={formState.sessionId}
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {formatDate(session.startsAt, "short")} · {session.openSeats} open
              </option>
            ))}
          </select>
        </label>

        <label>
          Attendee name
          <input
            onChange={(event) =>
              setFormState((current) => ({ ...current, attendeeName: event.target.value }))
            }
            value={formState.attendeeName}
          />
        </label>

        <label>
          Phone
          <input
            onChange={(event) =>
              setFormState((current) => ({ ...current, phone: event.target.value }))
            }
            placeholder="+1 555-0142"
            value={formState.phone}
          />
        </label>

        <label>
          Requested host
          <input
            onChange={(event) =>
              setFormState((current) => ({ ...current, requestedHost: event.target.value }))
            }
            placeholder={selectedSession?.hostName ?? "Any host"}
            value={formState.requestedHost}
          />
        </label>

        <label>
          Priority
          <select
            onChange={(event) =>
              setFormState((current) => ({ ...current, urgency: event.target.value }))
            }
            value={formState.urgency}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>

      {selectedSession ? (
        <div className="info-card">
          <strong>{selectedSession.title}</strong>
          <span>
            {formatDate(selectedSession.startsAt, "short")} · {selectedSession.hostName} ·{" "}
            {selectedSession.room}
          </span>
          <span>
            {selectedSession.openSeats > 0
              ? `${selectedSession.openSeats} seats open now.`
              : "Currently full, so this attendee will go straight to the rescue waitlist."}
          </span>
        </div>
      ) : null}

      <label>
        Ops note
        <textarea
          onChange={(event) =>
            setFormState((current) => ({ ...current, notes: event.target.value }))
          }
          placeholder="Accessibility note, arrival timing, or handoff detail…"
          rows={4}
          value={formState.notes}
        />
      </label>

      {localError ? <p className="error-banner inline">{localError}</p> : null}
      <button disabled={disabled} type="submit">
        {disabled ? "Saving…" : "Book attendee"}
      </button>
    </form>
  );
}

function CalendarBoard({ schedule }: { schedule: ScheduleItem[] }) {
  const groups = useMemo(() => {
    const byDay = new Map<string, ScheduleItem[]>();

    for (const session of schedule) {
      const dayLabel = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        weekday: "short",
      }).format(new Date(session.startsAt));

      const current = byDay.get(dayLabel) ?? [];
      current.push(session);
      byDay.set(dayLabel, current);
    }

    return Array.from(byDay.entries());
  }, [schedule]);

  if (schedule.length === 0) {
    return <div className="empty-state">No sessions loaded.</div>;
  }

  return (
    <div className="calendar-board">
      {groups.map(([dayLabel, sessions]) => (
        <section className="day-column" key={dayLabel}>
          <div className="day-header">
            <h3>{dayLabel}</h3>
            <small>{sessions.length} sessions</small>
          </div>

          <div className="session-stack">
            {sessions.map((session) => {
              const fillPercent =
                session.capacity === 0
                  ? 0
                  : Math.min((session.bookedCount / session.capacity) * 100, 100);

              return (
                <article className="session-card" key={session.id}>
                  <div className="row-between">
                    <p className="session-time">{formatDate(session.startsAt, "short")}</p>
                    <span className={`tag ${statusTone(session.statusLabel)}`}>
                      {session.statusLabel}
                    </span>
                  </div>

                  <h3 className="session-title">{session.title}</h3>
                  <p className="session-meta">
                    {session.track} · {session.hostName} · {session.room}
                  </p>

                  <div className="meter">
                    <span style={{ width: `${fillPercent}%` }} />
                  </div>

                  <div className="row-between compact">
                    <small>
                      {session.bookedCount}/{session.capacity} booked · {session.checkedInCount}{" "}
                      checked in
                    </small>
                    <small>{session.waitlistDemand} waiting</small>
                  </div>

                  <div className="tag-row">
                    <span className={`tag ${session.openSeats > 0 ? "green" : "slate"}`}>
                      {session.openSeats > 0 ? `${session.openSeats} open` : "Sold out"}
                    </span>
                    {session.conflict ? <span className="tag amber">Host overlap</span> : null}
                  </div>

                  <p className="attendee-preview">
                    {session.attendeePreview.length > 0
                      ? `Booked: ${session.attendeePreview.join(", ")}${
                          session.bookedCount > session.attendeePreview.length ? "…" : ""
                        }`
                      : "No attendees booked yet."}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function SuggestionsList({
  disabled,
  onBackfill,
  suggestions,
}: {
  disabled: boolean;
  onBackfill: (suggestion: SuggestionItem) => Promise<void> | void;
  suggestions: SuggestionItem[];
}) {
  if (suggestions.length === 0) {
    return <div className="empty-state">No rescue matches are live right now.</div>;
  }

  return (
    <div className="stack-list">
      {suggestions.map((suggestion) => (
        <article className="stack-card" key={`${suggestion.sessionId}-${suggestion.waitlistId}`}>
          <div>
            <p className="stack-title">{suggestion.attendeeName}</p>
            <p className="stack-meta">
              {suggestion.sessionTitle} · {suggestion.hostName} · {suggestion.windowLabel}
            </p>
            <p className="stack-note">
              {suggestion.reason}
              {suggestion.requestedSessionTitle
                ? ` · requested ${suggestion.requestedSessionTitle}`
                : ""}
            </p>
          </div>
          <div className="stack-actions vertical align-end">
            <span className="score-pill">score {suggestion.score}</span>
            <button disabled={disabled} onClick={() => void onBackfill(suggestion)} type="button">
              Rescue seat
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function CheckInBoard({
  disabled,
  items,
  onRelease,
  onUpdate,
}: {
  disabled: boolean;
  items: CheckInItem[];
  onRelease: (item: CheckInItem) => Promise<void> | void;
  onUpdate: (item: CheckInItem, arrivalState: string) => Promise<void> | void;
}) {
  if (items.length === 0) {
    return <div className="empty-state">No attendee rows available.</div>;
  }

  return (
    <div className="stack-list">
      {items.map((item) => (
        <article className="stack-card" key={item.bookingId}>
          <div>
            <div className="row-between">
              <p className="stack-title">{item.attendeeName}</p>
              <span className={`tag ${stateTone(item.arrivalState)}`}>{item.arrivalState}</span>
            </div>
            <p className="stack-meta">
              {item.sessionTitle} · {formatDate(item.startsAt, "short")} · {item.room}
            </p>
            <p className="stack-note">{item.deskNote || item.releaseReason || "No desk note."}</p>
          </div>

          <div className="stack-actions vertical align-end">
            <span className={`tag ${item.seatStatus === "released" ? "rose" : "slate"}`}>
              {item.seatStatus}
            </span>

            {item.seatStatus === "released" ? (
              <small className="muted">Seat reopened for rescue booking.</small>
            ) : (
              <div className="button-row">
                <button
                  disabled={disabled}
                  onClick={() => void onUpdate(item, "checked-in")}
                  type="button"
                >
                  Arrived
                </button>
                <button
                  className="ghost-button"
                  disabled={disabled}
                  onClick={() => void onUpdate(item, "called")}
                  type="button"
                >
                  Called
                </button>
                <button
                  className="ghost-button"
                  disabled={disabled}
                  onClick={() => void onUpdate(item, "no-show")}
                  type="button"
                >
                  No-show
                </button>
                <button
                  className="ghost-button"
                  disabled={disabled || item.arrivalState === "checked-in"}
                  onClick={() => void onRelease(item)}
                  type="button"
                >
                  Release seat
                </button>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function WaitlistTable({ waitlist }: { waitlist: WaitlistItem[] }) {
  if (waitlist.length === 0) {
    return <div className="empty-state">No waitlist entries yet.</div>;
  }

  return (
    <div className="stack-list">
      {waitlist.map((item) => (
        <article className="stack-card" key={item.id}>
          <div>
            <div className="row-between">
              <p className="stack-title">{item.attendeeName}</p>
              <span className={`tag ${urgencyTone(item.urgency)}`}>{item.urgency}</span>
            </div>
            <p className="stack-meta">
              {item.requestedSessionTitle ?? "Any matching session"} · {item.attendeePhone}
            </p>
            <p className="stack-note">
              Window {formatDate(item.preferredWindowStart, "short")} to{" "}
              {formatDate(item.preferredWindowEnd, "short")}
            </p>
            {item.notes ? <p className="stack-note">{item.notes}</p> : null}
          </div>
          <div className="stack-actions vertical align-end">
            <span className="score-pill">score {item.score}</span>
            <small className="muted">status: {item.status}</small>
          </div>
        </article>
      ))}
    </div>
  );
}

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    ...init,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // ignore JSON parse failures
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function formatDate(value: string, mode: "day" | "short" | "time") {
  const date = new Date(value);

  if (mode === "time") {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  if (mode === "day") {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(date);
}

function stateTone(value: string) {
  if (value === "checked-in") {
    return "green";
  }

  if (value === "late" || value === "no-show" || value === "released") {
    return "rose";
  }

  if (value === "called" || value === "boarding") {
    return "amber";
  }

  return "slate";
}

function statusTone(value: string) {
  if (value === "live") {
    return "green";
  }

  if (value === "boarding soon") {
    return "amber";
  }

  if (value === "wrapped") {
    return "slate";
  }

  return "blue";
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function urgencyTone(value: string) {
  if (value === "high") {
    return "rose";
  }

  if (value === "medium") {
    return "amber";
  }

  return "green";
}
