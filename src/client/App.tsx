import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import type { DashboardData, CheckInItem, ScheduleItem, SessionUser, SuggestionItem, WaitlistItem } from "./types";

type SessionResponse = {
  user: SessionUser | null;
};

type WaitlistFormState = {
  notes: string;
  attendeeName: string;
  phone: string;
  preferredWindowEnd: string;
  preferredWindowStart: string;
  requestedHost: string;
  urgency: string;
};

const defaultWaitlistForm: WaitlistFormState = {
  notes: "",
  attendeeName: "",
  phone: "",
  preferredWindowEnd: "",
  preferredWindowStart: "",
  requestedHost: "",
  urgency: "medium",
};

export function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
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
        const nextDashboard = await api<DashboardData>("/api/dashboard");
        setDashboard(nextDashboard);
      }
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setSessionChecked(true);
    }
  }

  async function refreshDashboard() {
    const nextDashboard = await api<DashboardData>("/api/dashboard");
    setDashboard(nextDashboard);
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
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
      await refreshDashboard();
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    setIsSubmitting(true);
    setError(null);
    try {
      await api("/api/logout", { method: "POST" });
      setUser(null);
      setDashboard(null);
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleWaitlistSubmit(state: WaitlistFormState) {
    setIsSubmitting(true);
    setError(null);
    try {
      const nextDashboard = await api<DashboardData>("/api/waitlist", {
        body: JSON.stringify(state),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      setDashboard(nextDashboard);
    } catch (nextError) {
      setError(toMessage(nextError));
      throw nextError;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleBackfill(suggestion: SuggestionItem) {
    setIsSubmitting(true);
    setError(null);
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
    } catch (nextError) {
      setError(toMessage(nextError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCheckInUpdate(checkIn: CheckInItem, arrivalState: string) {
    setIsSubmitting(true);
    setError(null);
    try {
      const nextDashboard = await api<DashboardData>(
        `/api/check-ins/${checkIn.sessionId}/state`,
        {
          body: JSON.stringify({
            arrivalState,
            deskNote: checkIn.deskNote,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        },
      );
      setDashboard(nextDashboard);
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
        label: "Open slots",
        value: String(dashboard.metrics.openSlots),
      },
      {
        label: "Waiting list",
        value: String(dashboard.metrics.waitlistCount),
      },
      {
        label: "Escalations",
        value: String(dashboard.metrics.escalations),
      },
    ];
  }, [dashboard]);

  if (!sessionChecked) {
    return <Shell><div className="empty-state">Loading SeatSprint…</div></Shell>;
  }

  if (!user) {
    return (
      <Shell>
        <section className="hero-card login-card">
          <div>
            <p className="eyebrow">Nightshift 066</p>
            <h1>SeatSprint</h1>
            <p className="hero-copy">
              Front-desk command center for keeping workshop schedules full, rescuing open slots,
              and surfacing attendees who are drifting toward late or no-show.
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
              {isSubmitting ? "Signing in…" : "Sign in to coordinator desk"}
            </button>
            <p className="hint">Seeded login is prefilled so you can validate the full flow quickly.</p>
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
          <p className="eyebrow">Coordinator desk</p>
          <h1>SeatSprint</h1>
          <p className="hero-copy compact">
            Live workshop schedule, rescue queue, and check-in escalation board in one surface.
          </p>
        </div>
        <div className="topbar-actions">
          <div className="user-chip">
            <span>{user.name}</span>
            <small>{user.email}</small>
          </div>
          <button className="ghost-button" disabled={isSubmitting} onClick={handleLogout} type="button">
            Log out
          </button>
        </div>
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="stats-grid">
        {summary.map((item) => (
          <article className="stat-card" key={item.label}>
            <p>{item.label}</p>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="grid layout-grid">
        <Panel title="Workshop schedule" subtitle="Capacity, open slots, and hidden host conflicts.">
          <ScheduleTable schedule={dashboard?.schedule ?? []} />
        </Panel>

        <Panel title="Backfill suggestions" subtitle="Ranked waitlist matches for every open slot.">
          <SuggestionsList
            disabled={isSubmitting}
            onBackfill={handleBackfill}
            suggestions={dashboard?.suggestions ?? []}
          />
        </Panel>

        <Panel title="Waitlist intake" subtitle="Capture same-day demand and score it for rescue priority.">
          <WaitlistForm disabled={isSubmitting} onSubmit={handleWaitlistSubmit} />
        </Panel>

        <Panel title="Live check-in board" subtitle="Mark arrivals and escalate late or no-show attendees.">
          <CheckInBoard
            disabled={isSubmitting}
            items={dashboard?.checkInBoard ?? []}
            onUpdate={handleCheckInUpdate}
          />
        </Panel>

        <Panel title="Waitlist detail" subtitle="Sorted by urgency and time-window fit.">
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
      <div className="content">{children}</div>
    </main>
  );
}

function Panel({ children, subtitle, title }: { children: ReactNode; subtitle: string; title: string }) {
  return (
    <section className="panel">
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

function ScheduleTable({ schedule }: { schedule: ScheduleItem[] }) {
  if (schedule.length === 0) {
    return <div className="empty-state">No sessions loaded.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Attendee</th>
            <th>Host</th>
            <th>Room</th>
            <th>Capacity</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {schedule.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{formatDate(item.startsAt, "time")}</strong>
                <small>{formatDate(item.startsAt, "day")}</small>
              </td>
              <td>{item.attendeeName}</td>
              <td>{item.hostName}</td>
              <td>{item.room}</td>
              <td>
                {item.booked}/{item.capacity}
                <small>{item.openSlots} open</small>
              </td>
              <td>
                <div className="tag-row">
                  <span className={`tag ${item.openSlots > 0 ? "green" : "slate"}`}>
                    {item.openSlots > 0 ? "Open slot" : "Full"}
                  </span>
                  {item.conflict ? <span className="tag amber">Conflict</span> : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    return <div className="empty-state">No live rescue matches right now.</div>;
  }

  return (
    <div className="stack-list">
      {suggestions.map((suggestion) => (
        <article className="stack-card" key={`${suggestion.sessionId}-${suggestion.waitlistId}`}>
          <div>
            <p className="stack-title">{suggestion.attendeeName}</p>
            <p className="stack-meta">
              Slot for {suggestion.sessionAttendeeName} · {suggestion.hostName} · {suggestion.windowLabel}
            </p>
          </div>
          <div className="stack-actions">
            <span className="score-pill">score {suggestion.score}</span>
            <button disabled={disabled} onClick={() => void onBackfill(suggestion)} type="button">
              Backfill slot
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function WaitlistForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (state: WaitlistFormState) => Promise<void>;
}) {
  const [formState, setFormState] = useState<WaitlistFormState>(defaultWaitlistForm);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    if (!formState.attendeeName || !formState.phone || !formState.preferredWindowStart || !formState.preferredWindowEnd) {
      setLocalError("Attendee, phone, and time window are required.");
      return;
    }

    try {
      await onSubmit(formState);
      setFormState(defaultWaitlistForm);
    } catch {
      // surfaced globally
    }
  }

  return (
    <form className="waitlist-form" onSubmit={submit}>
      <div className="field-grid">
        <label>
          Attendee name
          <input
            onChange={(event) => setFormState((current) => ({ ...current, attendeeName: event.target.value }))}
            value={formState.attendeeName}
          />
        </label>
        <label>
          Phone
          <input
            onChange={(event) => setFormState((current) => ({ ...current, phone: event.target.value }))}
            placeholder="+1 555-0109"
            value={formState.phone}
          />
        </label>
        <label>
          Requested host
          <input
            onChange={(event) => setFormState((current) => ({ ...current, requestedHost: event.target.value }))}
            placeholder="Dr. Shah"
            value={formState.requestedHost}
          />
        </label>
        <label>
          Urgency
          <select
            onChange={(event) => setFormState((current) => ({ ...current, urgency: event.target.value }))}
            value={formState.urgency}
          >
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          Window start
          <input
            onChange={(event) => setFormState((current) => ({ ...current, preferredWindowStart: event.target.value }))}
            type="datetime-local"
            value={formState.preferredWindowStart}
          />
        </label>
        <label>
          Window end
          <input
            onChange={(event) => setFormState((current) => ({ ...current, preferredWindowEnd: event.target.value }))}
            type="datetime-local"
            value={formState.preferredWindowEnd}
          />
        </label>
      </div>
      <label>
        Desk notes
        <textarea
          onChange={(event) => setFormState((current) => ({ ...current, notes: event.target.value }))}
          placeholder="Reason for same-day slot, language preference, callback note…"
          rows={4}
          value={formState.notes}
        />
      </label>
      {localError ? <p className="error-banner inline">{localError}</p> : null}
      <button disabled={disabled} type="submit">{disabled ? "Saving…" : "Add to waitlist"}</button>
    </form>
  );
}

function CheckInBoard({
  disabled,
  items,
  onUpdate,
}: {
  disabled: boolean;
  items: CheckInItem[];
  onUpdate: (item: CheckInItem, arrivalState: string) => Promise<void> | void;
}) {
  if (items.length === 0) {
    return <div className="empty-state">No check-in rows available.</div>;
  }

  return (
    <div className="stack-list">
      {items.map((item) => (
        <article className="stack-card" key={item.sessionId}>
          <div>
            <p className="stack-title">{item.attendeeName}</p>
            <p className="stack-meta">
              {formatDate(item.startsAt, "time")} · {item.hostName} · {item.room}
            </p>
            <p className="stack-note">{item.deskNote}</p>
          </div>
          <div className="stack-actions vertical">
            <span className={`tag ${stateTone(item.arrivalState)}`}>{item.arrivalState}</span>
            <div className="button-row">
              <button disabled={disabled} onClick={() => void onUpdate(item, "checked-in")} type="button">Arrived</button>
              <button className="ghost-button" disabled={disabled} onClick={() => void onUpdate(item, "called")} type="button">Called</button>
              <button className="ghost-button" disabled={disabled} onClick={() => void onUpdate(item, "no-show")} type="button">No-show</button>
            </div>
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
              {item.requestedHost || "Any host"} · {item.phone} · {formatDate(item.preferredWindowStart, "short")} to {formatDate(item.preferredWindowEnd, "short")}
            </p>
            <p className="stack-note">{item.notes}</p>
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
      // ignore
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function formatDate(value: string, mode: "time" | "day" | "short") {
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

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function stateTone(value: string) {
  if (value === "checked-in") {
    return "green";
  }
  if (value === "late" || value === "no-show") {
    return "rose";
  }
  if (value === "called") {
    return "amber";
  }
  return "slate";
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
