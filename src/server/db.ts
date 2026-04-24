import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

type DbValue = number | string | null;

const CURRENT_DB_PATH = path.join(
  process.cwd(),
  ".seatsprint-data",
  "seatsprint-v2.sqlite",
);

export type SessionUser = {
  email: string;
  id: number;
  name: string;
  role: string;
};

type EventSessionRow = {
  capacity: number;
  durationMin: number;
  hostName: string;
  id: number;
  room: string;
  startsAt: string;
  status: string;
  title: string;
  track: string;
};

type BookingRow = {
  arrivalState: string;
  attendeeName: string;
  attendeePhone: string;
  bookingId: number;
  bookingStatus: string;
  checkedInAt: string | null;
  createdAt: string;
  deskNote: string;
  hostName: string;
  releasedAt: string | null;
  releaseReason: string;
  room: string;
  sessionId: number;
  sessionTitle: string;
  startsAt: string;
};

type WaitlistRow = {
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

type ScheduleItem = EventSessionRow & {
  attendeePreview: string[];
  bookedCount: number;
  checkedInCount: number;
  conflict: boolean;
  openSeats: number;
  statusLabel: string;
  waitlistDemand: number;
};

type CheckInBoardItem = {
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

type WaitlistItem = WaitlistRow;

type SuggestionItem = {
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

type DashboardData = {
  checkInBoard: CheckInBoardItem[];
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

type BookingRequestInput = {
  attendeeName: string;
  notes: string;
  phone: string;
  requestedHost: string;
  sessionId: number;
  urgency: string;
};

type BookingRequestResult = {
  attendeeName: string;
  dashboard: DashboardData;
  outcome: "booked" | "waitlisted";
  sessionTitle: string;
};

type CheckInUpdateInput = {
  arrivalState: string;
  bookingId: number;
  deskNote?: string;
};

const ACTIVE_BOOKING_STATUS = "active";
const RELEASED_BOOKING_STATUS = "released";

export class AppDb {
  private constructor(
    private readonly db: Database,
    private readonly filePath: string,
    private readonly SQL: SqlJsStatic,
  ) {}

  static async create(): Promise<AppDb> {
    const SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(CURRENT_DB_PATH), { recursive: true });

    const db = fs.existsSync(CURRENT_DB_PATH)
      ? new SQL.Database(fs.readFileSync(CURRENT_DB_PATH))
      : new SQL.Database();

    const appDb = new AppDb(db, CURRENT_DB_PATH, SQL);
    appDb.migrate();
    appDb.seedUsers();
    appDb.seedIfNeeded();
    appDb.persist();
    return appDb;
  }

  createBookingRequest(input: BookingRequestInput): BookingRequestResult {
    const attendeeName = input.attendeeName.trim();
    const phone = input.phone.trim();
    const requestedHost = input.requestedHost.trim();
    const urgency = input.urgency.trim().toLowerCase() || "medium";
    const notes = input.notes.trim();
    const session = this.getEventSession(input.sessionId);

    if (!session) {
      throw new Error("Session not found");
    }

    if (!attendeeName || !phone) {
      throw new Error("Attendee name and phone are required");
    }

    if (this.hasActiveBooking(session.id, attendeeName)) {
      throw new Error(`${attendeeName} is already booked into ${session.title}`);
    }

    if (this.getOpenSeats(session.id) > 0) {
      this.insertBooking({
        attendeeName,
        attendeePhone: phone,
        note: notes,
        sessionId: session.id,
        source: "desk",
        sourceWaitlistId: null,
      });
      this.persist();
      return {
        attendeeName,
        dashboard: this.getDashboard(),
        outcome: "booked",
        sessionTitle: session.title,
      };
    }

    this.insertWaitlistEntry({
      attendeeName,
      attendeePhone: phone,
      notes,
      preferredWindowEnd: this.waitlistWindowEnd(session),
      preferredWindowStart: this.waitlistWindowStart(session),
      requestedHost: requestedHost || session.hostName,
      requestedSessionId: session.id,
      urgency,
    });
    this.persist();

    return {
      attendeeName,
      dashboard: this.getDashboard(),
      outcome: "waitlisted",
      sessionTitle: session.title,
    };
  }

  applyBackfill(sessionId: number, waitlistId: number): void {
    const session = this.getEventSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }

    if (this.getOpenSeats(sessionId) < 1) {
      throw new Error("Session no longer has an open seat");
    }

    const waitlistEntry = this.getWaitlistEntry(waitlistId);
    if (!waitlistEntry) {
      throw new Error("Waitlist entry not found");
    }

    if (waitlistEntry.status !== "waiting") {
      throw new Error("Waitlist entry has already been handled");
    }

    if (this.hasActiveBooking(sessionId, waitlistEntry.attendeeName)) {
      throw new Error(`${waitlistEntry.attendeeName} is already booked into this session`);
    }

    this.insertBooking({
      attendeeName: waitlistEntry.attendeeName,
      attendeePhone: waitlistEntry.attendeePhone,
      note: waitlistEntry.notes,
      sessionId,
      source: "rescue",
      sourceWaitlistId: waitlistId,
    });

    this.execute(
      `
        UPDATE waitlist_entries
        SET status = ?, rescued_session_id = ?, rescued_at = ?
        WHERE id = ?
      `,
      ["rescued", sessionId, new Date().toISOString(), waitlistId],
    );

    this.persist();
  }

  createSession(userId: number): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.execute(
      "INSERT INTO auth_sessions (token, user_id, created_at) VALUES (?, ?, ?)",
      [token, userId, new Date().toISOString()],
    );
    this.persist();
    return token;
  }

  deleteSession(token: string): void {
    this.execute("DELETE FROM auth_sessions WHERE token = ?", [token]);
    this.persist();
  }

  getDashboard(): DashboardData {
    const sessions = this.getRows<EventSessionRow>(
      `
        SELECT
          id,
          title,
          track,
          host_name AS hostName,
          room,
          starts_at AS startsAt,
          duration_min AS durationMin,
          capacity,
          status
        FROM event_sessions
        ORDER BY starts_at ASC
      `,
    );

    const bookings = this.getRows<BookingRow>(
      `
        SELECT
          b.id AS bookingId,
          b.event_session_id AS sessionId,
          s.title AS sessionTitle,
          b.attendee_name AS attendeeName,
          b.attendee_phone AS attendeePhone,
          s.host_name AS hostName,
          s.room,
          s.starts_at AS startsAt,
          b.arrival_state AS arrivalState,
          b.checked_in_at AS checkedInAt,
          b.booking_status AS bookingStatus,
          b.note AS deskNote,
          b.release_reason AS releaseReason,
          b.released_at AS releasedAt,
          b.created_at AS createdAt
        FROM bookings b
        INNER JOIN event_sessions s ON s.id = b.event_session_id
        ORDER BY s.starts_at ASC, b.created_at ASC, b.id ASC
      `,
    );

    const waitlist = this.getRows<WaitlistRow>(
      `
        SELECT
          w.id,
          w.attendee_name AS attendeeName,
          w.attendee_phone AS attendeePhone,
          w.requested_session_id AS requestedSessionId,
          s.title AS requestedSessionTitle,
          w.requested_host AS requestedHost,
          w.preferred_window_start AS preferredWindowStart,
          w.preferred_window_end AS preferredWindowEnd,
          w.urgency,
          w.note AS notes,
          w.score,
          w.status,
          w.created_at AS createdAt
        FROM waitlist_entries w
        LEFT JOIN event_sessions s ON s.id = w.requested_session_id
        ORDER BY
          CASE w.status WHEN 'waiting' THEN 0 ELSE 1 END,
          w.score DESC,
          w.created_at ASC
      `,
    );

    const activeBookingsBySession = new Map<number, BookingRow[]>();
    for (const booking of bookings) {
      if (booking.bookingStatus !== ACTIVE_BOOKING_STATUS) {
        continue;
      }

      const current = activeBookingsBySession.get(booking.sessionId) ?? [];
      current.push(booking);
      activeBookingsBySession.set(booking.sessionId, current);
    }

    const waitingEntries = waitlist.filter((entry) => entry.status === "waiting");

    const schedule = sessions.map((session) => {
      const activeBookings = activeBookingsBySession.get(session.id) ?? [];
      const bookedCount = activeBookings.length;
      const checkedInCount = activeBookings.filter(
        (booking) => booking.checkedInAt !== null,
      ).length;
      const openSeats = Math.max(session.capacity - bookedCount, 0);
      const attendeePreview = activeBookings
        .slice(0, 3)
        .map((booking) => booking.attendeeName);
      const waitlistDemand = waitingEntries.filter((entry) =>
        this.matchesWindow(session.startsAt, entry),
      ).length;

      return {
        ...session,
        attendeePreview,
        bookedCount,
        checkedInCount,
        conflict: this.hasConflict(session, sessions),
        openSeats,
        statusLabel: this.deriveSessionStatus(session),
        waitlistDemand,
      };
    });

    const sessionById = new Map(schedule.map((session) => [session.id, session]));

    const checkInBoard = bookings.map((booking) => {
      const session = sessionById.get(booking.sessionId);
      if (!session) {
        throw new Error(`Missing session ${booking.sessionId}`);
      }

      return {
        arrivalState: this.deriveArrivalState({
          bookingStatus: booking.bookingStatus,
          checkedInAt: booking.checkedInAt,
          startsAt: booking.startsAt,
          storedState: booking.arrivalState,
        }),
        attendeeName: booking.attendeeName,
        bookingId: booking.bookingId,
        checkedInAt: booking.checkedInAt,
        deskNote: booking.deskNote,
        hostName: booking.hostName,
        releaseReason: booking.releaseReason,
        room: booking.room,
        seatStatus: booking.bookingStatus,
        sessionId: booking.sessionId,
        sessionTitle: session.title,
        startsAt: booking.startsAt,
      };
    });

    const suggestions = schedule
      .filter((session) => session.openSeats > 0)
      .flatMap((session) =>
        waitingEntries
          .filter((entry) => this.matchesWindow(session.startsAt, entry))
          .map((entry) => ({
            attendeeName: entry.attendeeName,
            hostName: session.hostName,
            reason: this.suggestionReason(session, entry),
            requestedSessionTitle: entry.requestedSessionTitle,
            score: this.suggestionScore(session, entry),
            sessionId: session.id,
            sessionTitle: session.title,
            waitlistId: entry.id,
            windowLabel: `${this.formatTime(entry.preferredWindowStart)}-${this.formatTime(entry.preferredWindowEnd)}`,
          })),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    return {
      checkInBoard,
      metrics: {
        checkedInCount: checkInBoard.filter(
          (item) =>
            item.seatStatus === ACTIVE_BOOKING_STATUS &&
            item.arrivalState === "checked-in",
        ).length,
        openSeats: schedule.reduce((sum, session) => sum + session.openSeats, 0),
        todaySessions: schedule.filter((session) => {
          const startsAt = new Date(session.startsAt);
          return startsAt >= todayStart && startsAt < tomorrowStart;
        }).length,
        waitlistCount: waitingEntries.length,
      },
      schedule,
      suggestions,
      waitlist,
    };
  }

  getUserBySession(token: string): SessionUser | null {
    const statement = this.db.prepare(
      `
        SELECT u.id, u.email, u.name, u.role
        FROM auth_sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
      `,
    );
    statement.bind([token]);

    if (!statement.step()) {
      statement.free();
      return null;
    }

    const row = statement.getAsObject() as Record<string, string | number>;
    statement.free();
    return {
      email: String(row.email),
      id: Number(row.id),
      name: String(row.name),
      role: String(row.role),
    };
  }

  login(email: string, password: string): SessionUser | null {
    const statement = this.db.prepare(
      `
        SELECT id, email, name, role
        FROM users
        WHERE email = ? AND password_hash = ?
      `,
    );
    statement.bind([email.trim().toLowerCase(), this.hash(password)]);

    if (!statement.step()) {
      statement.free();
      return null;
    }

    const row = statement.getAsObject() as Record<string, string | number>;
    statement.free();
    return {
      email: String(row.email),
      id: Number(row.id),
      name: String(row.name),
      role: String(row.role),
    };
  }

  releaseSeat(bookingId: number, releaseReason: string): void {
    const booking = this.getBooking(bookingId);
    if (!booking) {
      throw new Error("Booking not found");
    }

    if (booking.bookingStatus === RELEASED_BOOKING_STATUS) {
      throw new Error("Seat has already been released");
    }

    const arrivalState = this.deriveArrivalState({
      bookingStatus: booking.bookingStatus,
      checkedInAt: booking.checkedInAt,
      startsAt: booking.startsAt,
      storedState: booking.arrivalState,
    });

    if (arrivalState === "checked-in") {
      throw new Error("Checked-in attendees cannot be released");
    }

    this.execute(
      `
        UPDATE bookings
        SET booking_status = ?, arrival_state = ?, released_at = ?, release_reason = ?
        WHERE id = ?
      `,
      [
        RELEASED_BOOKING_STATUS,
        "released",
        new Date().toISOString(),
        releaseReason.trim() || "Seat reopened by desk.",
        bookingId,
      ],
    );

    this.persist();
  }

  updateCheckInState(input: CheckInUpdateInput): void {
    const booking = this.getBooking(input.bookingId);
    if (!booking) {
      throw new Error("Booking not found");
    }

    if (booking.bookingStatus === RELEASED_BOOKING_STATUS) {
      throw new Error("Released seats cannot be checked in");
    }

    const normalizedState = this.normalizeArrivalState(input.arrivalState);
    const checkedInAt =
      normalizedState === "checked-in" ? booking.checkedInAt ?? new Date().toISOString() : null;

    this.execute(
      `
        UPDATE bookings
        SET arrival_state = ?, checked_in_at = ?, note = ?
        WHERE id = ?
      `,
      [normalizedState, checkedInAt, input.deskNote?.trim() ?? booking.deskNote, input.bookingId],
    );

    this.persist();
  }

  private calculateWaitlistScore(
    urgency: string,
    requestedHost: string,
    requestedSessionId: number | null,
  ): number {
    const urgencyMap: Record<string, number> = {
      high: 95,
      low: 45,
      medium: 70,
    };

    return (
      (urgencyMap[urgency] ?? urgencyMap.medium) +
      (requestedHost ? 10 : 0) +
      (requestedSessionId ? 12 : 0)
    );
  }

  private deriveArrivalState(input: {
    bookingStatus: string;
    checkedInAt: string | null;
    startsAt: string;
    storedState: string;
  }): string {
    if (input.bookingStatus === RELEASED_BOOKING_STATUS) {
      return "released";
    }

    if (input.checkedInAt) {
      return "checked-in";
    }

    if (input.storedState === "called" || input.storedState === "no-show") {
      return input.storedState;
    }

    const minutesPastStart = Math.round(
      (Date.now() - new Date(input.startsAt).getTime()) / 60_000,
    );

    if (minutesPastStart >= 20) {
      return "no-show";
    }

    if (minutesPastStart >= 5) {
      return "late";
    }

    if (minutesPastStart >= 0) {
      return "boarding";
    }

    return "scheduled";
  }

  private deriveSessionStatus(session: EventSessionRow): string {
    const now = Date.now();
    const startsAt = new Date(session.startsAt).getTime();
    const endsAt = startsAt + session.durationMin * 60_000;

    if (now >= endsAt) {
      return "wrapped";
    }

    if (now >= startsAt) {
      return "live";
    }

    if (startsAt - now <= 30 * 60_000) {
      return "boarding soon";
    }

    return session.status;
  }

  private execute(query: string, params: DbValue[] = []): void {
    const statement = this.db.prepare(query);
    statement.run(params);
    statement.free();
  }

  private formatTime(value: string): string {
    return new Date(value).toISOString().slice(11, 16);
  }

  private getBooking(bookingId: number): BookingRow | null {
    const rows = this.getRows<BookingRow>(
      `
        SELECT
          b.id AS bookingId,
          b.event_session_id AS sessionId,
          s.title AS sessionTitle,
          b.attendee_name AS attendeeName,
          b.attendee_phone AS attendeePhone,
          s.host_name AS hostName,
          s.room,
          s.starts_at AS startsAt,
          b.arrival_state AS arrivalState,
          b.checked_in_at AS checkedInAt,
          b.booking_status AS bookingStatus,
          b.note AS deskNote,
          b.release_reason AS releaseReason,
          b.released_at AS releasedAt,
          b.created_at AS createdAt
        FROM bookings b
        INNER JOIN event_sessions s ON s.id = b.event_session_id
        WHERE b.id = ?
      `,
      [bookingId],
    );
    return rows[0] ?? null;
  }

  private getEventSession(sessionId: number): EventSessionRow | null {
    const rows = this.getRows<EventSessionRow>(
      `
        SELECT
          id,
          title,
          track,
          host_name AS hostName,
          room,
          starts_at AS startsAt,
          duration_min AS durationMin,
          capacity,
          status
        FROM event_sessions
        WHERE id = ?
      `,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  private getOpenSeats(sessionId: number): number {
    const session = this.getEventSession(sessionId);
    if (!session) {
      return 0;
    }

    const activeBookingCount = Number(
      this.getScalar(
        `
          SELECT COUNT(*)
          FROM bookings
          WHERE event_session_id = ? AND booking_status = ?
        `,
        [sessionId, ACTIVE_BOOKING_STATUS],
      ) ?? 0,
    );

    return Math.max(session.capacity - activeBookingCount, 0);
  }

  private getRows<T>(query: string, params: DbValue[] = []): T[] {
    const statement = this.db.prepare(query);
    if (params.length > 0) {
      statement.bind(params);
    }

    const rows: T[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }
    statement.free();
    return rows;
  }

  private getScalar(query: string, params: DbValue[] = []): DbValue | undefined {
    const statement = this.db.prepare(query);
    if (params.length > 0) {
      statement.bind(params);
    }

    if (!statement.step()) {
      statement.free();
      return undefined;
    }

    const row = statement.get();
    statement.free();
    return row[0] as DbValue;
  }

  private getTableColumns(tableName: string): string[] {
    if (!this.tableExists(tableName)) {
      return [];
    }

    const result = this.db.exec(`PRAGMA table_info(${tableName})`);
    return result[0]?.values.map((row) => String(row[1])) ?? [];
  }

  private getWaitlistEntry(waitlistId: number): WaitlistRow | null {
    const rows = this.getRows<WaitlistRow>(
      `
        SELECT
          w.id,
          w.attendee_name AS attendeeName,
          w.attendee_phone AS attendeePhone,
          w.requested_session_id AS requestedSessionId,
          s.title AS requestedSessionTitle,
          w.requested_host AS requestedHost,
          w.preferred_window_start AS preferredWindowStart,
          w.preferred_window_end AS preferredWindowEnd,
          w.urgency,
          w.note AS notes,
          w.score,
          w.status,
          w.created_at AS createdAt
        FROM waitlist_entries w
        LEFT JOIN event_sessions s ON s.id = w.requested_session_id
        WHERE w.id = ?
      `,
      [waitlistId],
    );

    return rows[0] ?? null;
  }

  private hasActiveBooking(sessionId: number, attendeeName: string): boolean {
    const count = Number(
      this.getScalar(
        `
          SELECT COUNT(*)
          FROM bookings
          WHERE event_session_id = ?
            AND booking_status = ?
            AND lower(attendee_name) = ?
        `,
        [sessionId, ACTIVE_BOOKING_STATUS, attendeeName.trim().toLowerCase()],
      ) ?? 0,
    );

    return count > 0;
  }

  private hasConflict(session: EventSessionRow, sessions: EventSessionRow[]): boolean {
    if (session.capacity < 1) {
      return true;
    }

    const sessionStarts = new Date(session.startsAt).getTime();
    const sessionEnds = sessionStarts + session.durationMin * 60_000;

    return sessions.some((candidate) => {
      if (candidate.id === session.id || candidate.hostName !== session.hostName) {
        return false;
      }

      const candidateStarts = new Date(candidate.startsAt).getTime();
      const candidateEnds = candidateStarts + candidate.durationMin * 60_000;

      return candidateStarts < sessionEnds && sessionStarts < candidateEnds;
    });
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private insertBooking(input: {
    attendeeName: string;
    attendeePhone: string;
    note: string;
    sessionId: number;
    source: string;
    sourceWaitlistId: number | null;
  }): void {
    this.execute(
      `
        INSERT INTO bookings (
          event_session_id,
          attendee_name,
          attendee_phone,
          note,
          source,
          source_waitlist_id,
          booking_status,
          arrival_state,
          checked_in_at,
          released_at,
          release_reason,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', ?)
      `,
      [
        input.sessionId,
        input.attendeeName,
        input.attendeePhone,
        input.note,
        input.source,
        input.sourceWaitlistId,
        ACTIVE_BOOKING_STATUS,
        "scheduled",
        new Date().toISOString(),
      ],
    );
  }

  private insertWaitlistEntry(input: {
    attendeeName: string;
    attendeePhone: string;
    notes: string;
    preferredWindowEnd: string;
    preferredWindowStart: string;
    requestedHost: string;
    requestedSessionId: number | null;
    urgency: string;
  }): void {
    this.execute(
      `
        INSERT INTO waitlist_entries (
          attendee_name,
          attendee_phone,
          requested_session_id,
          requested_host,
          preferred_window_start,
          preferred_window_end,
          urgency,
          note,
          score,
          status,
          rescued_session_id,
          rescued_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `,
      [
        input.attendeeName,
        input.attendeePhone,
        input.requestedSessionId,
        input.requestedHost,
        input.preferredWindowStart,
        input.preferredWindowEnd,
        input.urgency,
        input.notes,
        this.calculateWaitlistScore(
          input.urgency,
          input.requestedHost,
          input.requestedSessionId,
        ),
        "waiting",
        new Date().toISOString(),
      ],
    );
  }

  private matchesWindow(startsAt: string, entry: WaitlistRow): boolean {
    const sessionStarts = new Date(startsAt).getTime();
    const windowStart = new Date(entry.preferredWindowStart).getTime();
    const windowEnd = new Date(entry.preferredWindowEnd).getTime();
    return sessionStarts >= windowStart && sessionStarts <= windowEnd;
  }

  private migrate(): void {
    this.db.run("PRAGMA foreign_keys = ON;");
    this.renameLegacySessionsTable();
    this.ensureUsersSchema();
    this.ensureEventSchema();
    this.migrateLegacyWaitlist();
    this.migrateLegacySessionBoard();
  }

  private migrateLegacySessionBoard(): void {
    if (
      !this.tableExists("legacy_session_board") ||
      Number(this.getScalar("SELECT COUNT(*) FROM event_sessions") ?? 0) > 0
    ) {
      return;
    }

    const legacySessions = this.getRows<{
      attendeeName: string;
      booked: number;
      capacity: number;
      durationMin: number;
      hostName: string;
      id: number;
      room: string;
      startsAt: string;
      status: string;
    }>(
      `
        SELECT
          id,
          attendee_name AS attendeeName,
          host_name AS hostName,
          starts_at AS startsAt,
          duration_min AS durationMin,
          room,
          capacity,
          booked,
          status
        FROM legacy_session_board
        ORDER BY starts_at ASC
      `,
    );

    for (const session of legacySessions) {
      this.execute(
        `
          INSERT INTO event_sessions (
            title,
            track,
            host_name,
            room,
            starts_at,
            duration_min,
            capacity,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          `${session.room} Legacy Session`,
          "Legacy import",
          session.hostName,
          session.room,
          session.startsAt,
          session.durationMin,
          session.capacity,
          session.status,
          new Date().toISOString(),
        ],
      );

      const newSessionId = Number(this.getScalar("SELECT last_insert_rowid()") ?? 0);
      const bookingCount = Math.min(session.booked, session.capacity);

      for (let index = 0; index < bookingCount; index += 1) {
        this.insertBooking({
          attendeeName:
            index === 0 && session.attendeeName
              ? session.attendeeName
              : `Legacy attendee ${session.id}-${index + 1}`,
          attendeePhone: "unlisted",
          note: "Imported from the broken baseline schema.",
          sessionId: newSessionId,
          source: "legacy-import",
          sourceWaitlistId: null,
        });
      }
    }
  }

  private migrateLegacyWaitlist(): void {
    if (
      !this.tableExists("waitlist") ||
      Number(this.getScalar("SELECT COUNT(*) FROM waitlist_entries") ?? 0) > 0
    ) {
      return;
    }

    const legacyEntries = this.getRows<{
      attendeeName: string;
      createdAt: string;
      id: number;
      notes: string;
      phone: string;
      preferredWindowEnd: string;
      preferredWindowStart: string;
      requestedHost: string;
      score: number;
      status: string;
      urgency: string;
    }>(
      `
        SELECT
          id,
          attendee_name AS attendeeName,
          requested_host AS requestedHost,
          preferred_window_start AS preferredWindowStart,
          preferred_window_end AS preferredWindowEnd,
          urgency,
          phone,
          notes,
          score,
          status,
          created_at AS createdAt
        FROM waitlist
      `,
    );

    for (const entry of legacyEntries) {
      this.execute(
        `
          INSERT INTO waitlist_entries (
            attendee_name,
            attendee_phone,
            requested_session_id,
            requested_host,
            preferred_window_start,
            preferred_window_end,
            urgency,
            note,
            score,
            status,
            rescued_session_id,
            rescued_at,
            created_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        `,
        [
          entry.attendeeName,
          entry.phone,
          entry.requestedHost,
          entry.preferredWindowStart,
          entry.preferredWindowEnd,
          entry.urgency,
          entry.notes,
          entry.score,
          entry.status,
          entry.createdAt,
        ],
      );
    }
  }

  private normalizeArrivalState(value: string): string {
    if (value === "checked-in" || value === "called" || value === "no-show") {
      return value;
    }

    return "scheduled";
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const buffer = Buffer.from(this.db.export());
    fs.writeFileSync(this.filePath, buffer);
  }

  private renameLegacySessionsTable(): void {
    const sessionColumns = this.getTableColumns("sessions");
    if (sessionColumns.length === 0) {
      return;
    }

    const authColumns = ["token", "user_id", "created_at"];
    const eventColumns = [
      "attendee_name",
      "host_name",
      "starts_at",
      "duration_min",
      "room",
      "capacity",
      "booked",
      "status",
    ];

    if (
      authColumns.every((column) => sessionColumns.includes(column)) &&
      !this.tableExists("auth_sessions")
    ) {
      this.db.run("ALTER TABLE sessions RENAME TO auth_sessions");
      return;
    }

    if (
      eventColumns.every((column) => sessionColumns.includes(column)) &&
      !this.tableExists("legacy_session_board")
    ) {
      this.db.run("ALTER TABLE sessions RENAME TO legacy_session_board");
      return;
    }

    if (!this.tableExists("legacy_sessions_conflict")) {
      this.db.run("ALTER TABLE sessions RENAME TO legacy_sessions_conflict");
    }
  }

  private seedIfNeeded(): void {
    const sessionCount = Number(
      this.getScalar("SELECT COUNT(*) FROM event_sessions") ?? 0,
    );

    if (sessionCount > 0) {
      return;
    }

    const now = new Date();
    const makeIso = (minutesFromNow: number) =>
      new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

    const sessions = [
      {
        capacity: 4,
        durationMin: 75,
        hostName: "Morgan Hale",
        room: "Main Stage",
        startsAt: makeIso(-25),
        status: "scheduled",
        title: "Opening Jam: Stage Energy in 30 Minutes",
        track: "Performance",
      },
      {
        capacity: 4,
        durationMin: 60,
        hostName: "Jules Carter",
        room: "Audio Lab",
        startsAt: makeIso(40),
        status: "scheduled",
        title: "Mic Craft for Workshop Hosts",
        track: "Production",
      },
      {
        capacity: 3,
        durationMin: 90,
        hostName: "Naima Cole",
        room: "Maker Studio",
        startsAt: makeIso(110),
        status: "scheduled",
        title: "Rapid Zine Sprint",
        track: "Print",
      },
      {
        capacity: 5,
        durationMin: 50,
        hostName: "Asha Lin",
        room: "North Hall",
        startsAt: makeIso(200),
        status: "scheduled",
        title: "Creative Coding on the Big Screen",
        track: "Code",
      },
      {
        capacity: 4,
        durationMin: 120,
        hostName: "Naima Cole",
        room: "City Walk Meetup",
        startsAt: makeIso(1440 + 120),
        status: "scheduled",
        title: "Night Photo Walk",
        track: "Field",
      },
      {
        capacity: 3,
        durationMin: 70,
        hostName: "Morgan Hale",
        room: "Main Stage",
        startsAt: makeIso(1440 + 240),
        status: "scheduled",
        title: "Closing Showcase Rehearsal",
        track: "Performance",
      },
    ];

    for (const session of sessions) {
      this.execute(
        `
          INSERT INTO event_sessions (
            title,
            track,
            host_name,
            room,
            starts_at,
            duration_min,
            capacity,
            status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          session.title,
          session.track,
          session.hostName,
          session.room,
          session.startsAt,
          session.durationMin,
          session.capacity,
          session.status,
          new Date().toISOString(),
        ],
      );
    }

    const seededSessions = this.getRows<EventSessionRow>(
      `
        SELECT
          id,
          title,
          track,
          host_name AS hostName,
          room,
          starts_at AS startsAt,
          duration_min AS durationMin,
          capacity,
          status
        FROM event_sessions
        ORDER BY starts_at ASC
      `,
    );

    const sessionByTitle = new Map(seededSessions.map((session) => [session.title, session]));

    const seededBookings = [
      {
        attendeeName: "Rina Patel",
        attendeePhone: "+1 555-0101",
        note: "Green room pass already issued.",
        releaseReason: "",
        sessionTitle: "Opening Jam: Stage Energy in 30 Minutes",
        state: "checked-in",
      },
      {
        attendeeName: "Theo Nguyen",
        attendeePhone: "+1 555-0102",
        note: "Needs aisle seat for camera rig.",
        releaseReason: "",
        sessionTitle: "Opening Jam: Stage Energy in 30 Minutes",
        state: "called",
      },
      {
        attendeeName: "Harper Dean",
        attendeePhone: "+1 555-0103",
        note: "Arriving from speaker prep room.",
        releaseReason: "",
        sessionTitle: "Opening Jam: Stage Energy in 30 Minutes",
        state: "scheduled",
      },
      {
        attendeeName: "Mina Brooks",
        attendeePhone: "+1 555-0104",
        note: "Booked through venue desk.",
        releaseReason: "",
        sessionTitle: "Mic Craft for Workshop Hosts",
        state: "scheduled",
      },
      {
        attendeeName: "Kai Morgan",
        attendeePhone: "+1 555-0105",
        note: "Will join with interview notebook.",
        releaseReason: "",
        sessionTitle: "Mic Craft for Workshop Hosts",
        state: "scheduled",
      },
      {
        attendeeName: "Alma Rivera",
        attendeePhone: "+1 555-0106",
        note: "Prefers front third of the room.",
        releaseReason: "",
        sessionTitle: "Mic Craft for Workshop Hosts",
        state: "scheduled",
      },
      {
        attendeeName: "Noah Singh",
        attendeePhone: "+1 555-0107",
        note: "Already picked up materials kit.",
        releaseReason: "",
        sessionTitle: "Rapid Zine Sprint",
        state: "scheduled",
      },
      {
        attendeeName: "Sofia Kim",
        attendeePhone: "+1 555-0108",
        note: "Bringing two sample spreads.",
        releaseReason: "",
        sessionTitle: "Rapid Zine Sprint",
        state: "scheduled",
      },
      {
        attendeeName: "Cam Ellis",
        attendeePhone: "+1 555-0109",
        note: "Booked from earlier waitlist sweep.",
        releaseReason: "",
        sessionTitle: "Rapid Zine Sprint",
        state: "scheduled",
      },
      {
        attendeeName: "Jordan Price",
        attendeePhone: "+1 555-0110",
        note: "Accessibility headset requested.",
        releaseReason: "",
        sessionTitle: "Creative Coding on the Big Screen",
        state: "scheduled",
      },
      {
        attendeeName: "Avery Moss",
        attendeePhone: "+1 555-0111",
        note: "Laptop power seat requested.",
        releaseReason: "",
        sessionTitle: "Creative Coding on the Big Screen",
        state: "scheduled",
      },
      {
        attendeeName: "Parker Liu",
        attendeePhone: "+1 555-0112",
        note: "Will arrive with a student group.",
        releaseReason: "",
        sessionTitle: "Night Photo Walk",
        state: "scheduled",
      },
    ];

    for (const booking of seededBookings) {
      const session = sessionByTitle.get(booking.sessionTitle);
      if (!session) {
        continue;
      }

      this.insertBooking({
        attendeeName: booking.attendeeName,
        attendeePhone: booking.attendeePhone,
        note: booking.note,
        sessionId: session.id,
        source: "seed",
        sourceWaitlistId: null,
      });

      const bookingId = Number(this.getScalar("SELECT last_insert_rowid()") ?? 0);

      if (booking.state === "checked-in") {
        this.execute(
          `
            UPDATE bookings
            SET arrival_state = ?, checked_in_at = ?
            WHERE id = ?
          `,
          ["checked-in", makeIso(-18), bookingId],
        );
      } else if (booking.state === "called") {
        this.execute(
          "UPDATE bookings SET arrival_state = ? WHERE id = ?",
          ["called", bookingId],
        );
      }
    }

    const waitlistEntries = [
      {
        attendeeName: "Lena Ortiz",
        attendeePhone: "+1 555-0201",
        notes: "Can arrive in under ten minutes if a Main Stage seat opens.",
        requestedHost: "Morgan Hale",
        requestedSessionTitle: "Opening Jam: Stage Energy in 30 Minutes",
        urgency: "high",
      },
      {
        attendeeName: "Ezra Cole",
        attendeePhone: "+1 555-0202",
        notes: "Flexible on room, but wants the production track today.",
        requestedHost: "Jules Carter",
        requestedSessionTitle: "Mic Craft for Workshop Hosts",
        urgency: "medium",
      },
      {
        attendeeName: "Tara Shah",
        attendeePhone: "+1 555-0203",
        notes: "Can take any seat in the next two hours.",
        requestedHost: "",
        requestedSessionTitle: "Rapid Zine Sprint",
        urgency: "low",
      },
    ];

    for (const entry of waitlistEntries) {
      const session = sessionByTitle.get(entry.requestedSessionTitle);
      if (!session) {
        continue;
      }

      this.insertWaitlistEntry({
        attendeeName: entry.attendeeName,
        attendeePhone: entry.attendeePhone,
        notes: entry.notes,
        preferredWindowEnd: this.waitlistWindowEnd(session),
        preferredWindowStart: this.waitlistWindowStart(session),
        requestedHost: entry.requestedHost || session.hostName,
        requestedSessionId: session.id,
        urgency: entry.urgency,
      });
    }
  }

  private seedUsers(): void {
    const passwordHash = this.hash("nightshift066");
    const users = [
      {
        email: "host@seatsprint.local",
        name: "Morgan Hale",
        role: "host",
      },
      {
        email: "door@seatsprint.local",
        name: "Jules Carter",
        role: "door",
      },
      {
        email: "ops@seatsprint.local",
        name: "Naima Cole",
        role: "ops",
      },
    ];

    for (const user of users) {
      this.execute(
        `
          INSERT INTO users (email, name, role, password_hash)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            name = excluded.name,
            role = excluded.role,
            password_hash = excluded.password_hash
        `,
        [user.email, user.name, user.role, passwordHash],
      );
    }
  }

  private suggestionReason(session: ScheduleItem, entry: WaitlistRow): string {
    if (entry.requestedSessionId === session.id) {
      return "Requested session now has space";
    }

    if (entry.requestedHost && entry.requestedHost === session.hostName) {
      return "Host match inside the requested window";
    }

    return "Fits the attendee's rescue window";
  }

  private suggestionScore(session: ScheduleItem, entry: WaitlistRow): number {
    return (
      entry.score +
      (entry.requestedSessionId === session.id ? 25 : 0) +
      (entry.requestedHost === session.hostName ? 15 : 0) +
      (session.openSeats > 1 ? 5 : 0)
    );
  }

  private tableExists(tableName: string): boolean {
    const count = Number(
      this.getScalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName],
      ) ?? 0,
    );
    return count > 0;
  }

  private ensureEventSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS event_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        host_name TEXT NOT NULL,
        room TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        duration_min INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_session_id INTEGER NOT NULL,
        attendee_name TEXT NOT NULL,
        attendee_phone TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        source_waitlist_id INTEGER,
        booking_status TEXT NOT NULL,
        arrival_state TEXT NOT NULL,
        checked_in_at TEXT,
        released_at TEXT,
        release_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(event_session_id) REFERENCES event_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS waitlist_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendee_name TEXT NOT NULL,
        attendee_phone TEXT NOT NULL,
        requested_session_id INTEGER,
        requested_host TEXT NOT NULL DEFAULT '',
        preferred_window_start TEXT NOT NULL,
        preferred_window_end TEXT NOT NULL,
        urgency TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        score INTEGER NOT NULL,
        status TEXT NOT NULL,
        rescued_session_id INTEGER,
        rescued_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(requested_session_id) REFERENCES event_sessions(id),
        FOREIGN KEY(rescued_session_id) REFERENCES event_sessions(id)
      );

      CREATE INDEX IF NOT EXISTS bookings_session_status_idx
      ON bookings(event_session_id, booking_status);

      CREATE INDEX IF NOT EXISTS waitlist_status_idx
      ON waitlist_entries(status, score DESC, created_at ASC);
    `);
  }

  private ensureUsersSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'ops',
        password_hash TEXT NOT NULL
      );
    `);

    if (!this.getTableColumns("users").includes("role")) {
      this.db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'ops'");
    }
  }

  private waitlistWindowEnd(session: EventSessionRow): string {
    return new Date(
      new Date(session.startsAt).getTime() + (session.durationMin + 60) * 60_000,
    ).toISOString();
  }

  private waitlistWindowStart(session: EventSessionRow): string {
    return new Date(
      new Date(session.startsAt).getTime() - 30 * 60_000,
    ).toISOString();
  }
}
