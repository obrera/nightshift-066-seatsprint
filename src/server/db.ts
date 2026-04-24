import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

export type SessionUser = {
  email: string;
  id: number;
  name: string;
};

type SessionRow = {
  booked: number;
  capacity: number;
  durationMin: number;
  id: number;
  attendeeName: string;
  hostName: string;
  room: string;
  startsAt: string;
  status: string;
};

type WaitlistRow = {
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

type CheckInRow = {
  sessionId: number;
  arrivalState: string | null;
  checkedInAt: string | null;
  deskNote: string | null;
  attendeeName: string;
};

type DashboardData = {
  checkInBoard: Array<{
    sessionId: number;
    arrivalState: string;
    checkedInAt: string | null;
    deskNote: string;
    attendeeName: string;
    hostName: string;
    room: string;
    startsAt: string;
  }>;
  metrics: {
    escalations: number;
    openSlots: number;
    todaySessions: number;
    waitlistCount: number;
  };
  schedule: Array<SessionRow & { conflict: boolean; openSlots: number }>;
  suggestions: Array<{
    sessionId: number;
    sessionAttendeeName: string;
    attendeeName: string;
    hostName: string;
    score: number;
    waitlistId: number;
    windowLabel: string;
  }>;
  waitlist: WaitlistRow[];
};

export class AppDb {
  private constructor(
    private readonly db: Database,
    private readonly filePath: string,
    private readonly SQL: SqlJsStatic,
  ) {}

  static async create(): Promise<AppDb> {
    const SQL = await initSqlJs();
    const filePath = path.join(process.cwd(), "data", "queue-concierge.sqlite");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const db = fs.existsSync(filePath)
      ? new SQL.Database(fs.readFileSync(filePath))
      : new SQL.Database();

    const appDb = new AppDb(db, filePath, SQL);
    appDb.migrate();
    appDb.seedIfNeeded();
    appDb.persist();
    return appDb;
  }

  addWaitlistEntry(input: {
    notes: string;
    attendeeName: string;
    phone: string;
    preferredWindowEnd: string;
    preferredWindowStart: string;
    requestedHost: string;
    urgency: string;
  }): void {
    const score = this.calculateWaitlistScore(input.urgency, input.requestedHost);
    const statement = this.db.prepare(`
      INSERT INTO waitlist (
        attendee_name,
        requested_host,
        preferred_window_start,
        preferred_window_end,
        urgency,
        phone,
        notes,
        score,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)
    `);

    statement.run([
      input.attendeeName,
      input.requestedHost,
      input.preferredWindowStart,
      input.preferredWindowEnd,
      input.urgency,
      input.phone,
      input.notes,
      score,
      new Date().toISOString(),
    ]);

    statement.free();
    this.persist();
  }

  applyBackfill(sessionId: number, waitlistId: number): void {
    const slotStatement = this.db.prepare(
      "SELECT capacity, booked FROM sessions WHERE id = ?",
    );
    slotStatement.bind([sessionId]);

    if (!slotStatement.step()) {
      slotStatement.free();
      throw new Error("Session not found");
    }

    const [capacity, booked] = slotStatement.get() as [number, number];
    slotStatement.free();

    if (booked >= capacity) {
      throw new Error("Session is already full");
    }

    const sessionUpdate = this.db.prepare(
      "UPDATE sessions SET booked = booked + 1 WHERE id = ?",
    );
    sessionUpdate.run([sessionId]);
    sessionUpdate.free();

    const waitlistUpdate = this.db.prepare(
      "UPDATE waitlist SET status = 'contacted' WHERE id = ?",
    );
    waitlistUpdate.run([waitlistId]);
    waitlistUpdate.free();

    this.persist();
  }

  createSession(userId: number): string {
    const token = crypto.randomBytes(24).toString("hex");
    const statement = this.db.prepare(
      "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
    );
    statement.run([token, userId, new Date().toISOString()]);
    statement.free();
    this.persist();
    return token;
  }

  deleteSession(token: string): void {
    const statement = this.db.prepare("DELETE FROM sessions WHERE token = ?");
    statement.run([token]);
    statement.free();
    this.persist();
  }

  getDashboard(): DashboardData {
    const schedule = this.getRows<SessionRow>(`
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
      FROM sessions
      ORDER BY starts_at ASC
    `).map((session) => ({
      ...session,
      conflict: this.hasConflict(session),
      openSlots: Math.max(session.capacity - session.booked, 0),
    }));

    const waitlist = this.getRows<WaitlistRow>(`
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
      ORDER BY score DESC, created_at ASC
    `);

    const checkInRows = this.getRows<CheckInRow>(`
      SELECT
        c.session_id AS sessionId,
        c.arrival_state AS arrivalState,
        c.checked_in_at AS checkedInAt,
        c.desk_note AS deskNote,
        a.attendee_name AS attendeeName
      FROM check_ins c
      INNER JOIN sessions a ON a.id = c.session_id
      ORDER BY a.starts_at ASC
    `);

    const bySession = new Map(schedule.map((item) => [item.id, item]));
    const checkInBoard = checkInRows.map((row) => {
      const session = bySession.get(row.sessionId);
      if (!session) {
        throw new Error(`Missing session ${row.sessionId}`);
      }

      return {
        sessionId: row.sessionId,
        arrivalState: this.deriveArrivalState(
          session.startsAt,
          row.checkedInAt,
          row.arrivalState,
        ),
        checkedInAt: row.checkedInAt,
        deskNote: row.deskNote ?? "",
        attendeeName: row.attendeeName,
        hostName: session.hostName,
        room: session.room,
        startsAt: session.startsAt,
      };
    });

    const suggestions = schedule
      .filter((session) => session.openSlots > 0)
      .flatMap((session) => {
        return waitlist
          .filter((entry) => entry.status === "waiting")
          .filter((entry) => this.matchesWindow(session.startsAt, entry))
          .map((entry) => ({
            sessionId: session.id,
            sessionAttendeeName: session.attendeeName,
            attendeeName: entry.attendeeName,
            hostName: entry.requestedHost || session.hostName,
            score:
              entry.score +
              (entry.requestedHost === session.hostName ? 20 : 0) +
              (session.openSlots > 1 ? 5 : 0),
            waitlistId: entry.id,
            windowLabel: `${this.formatTime(entry.preferredWindowStart)}-${this.formatTime(entry.preferredWindowEnd)}`,
          }));
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 6);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    const metrics = {
      escalations: checkInBoard.filter((item) => item.arrivalState === "late" || item.arrivalState === "no-show").length,
      openSlots: schedule.reduce((sum, item) => sum + item.openSlots, 0),
      todaySessions: schedule.filter((item) => {
        const starts = new Date(item.startsAt);
        return starts >= todayStart && starts < tomorrowStart;
      }).length,
      waitlistCount: waitlist.filter((item) => item.status === "waiting").length,
    };

    return {
      checkInBoard,
      metrics,
      schedule,
      suggestions,
      waitlist,
    };
  }

  getUserBySession(token: string): SessionUser | null {
    const statement = this.db.prepare(`
      SELECT u.id, u.email, u.name
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `);
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
    };
  }

  login(email: string, password: string): SessionUser | null {
    const passwordHash = this.hash(password);
    const statement = this.db.prepare(`
      SELECT id, email, name
      FROM users
      WHERE email = ? AND password_hash = ?
    `);
    statement.bind([email.toLowerCase(), passwordHash]);

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
    };
  }

  updateCheckInState(input: {
    sessionId: number;
    arrivalState: string;
    deskNote?: string;
  }): void {
    const checkedInAt = input.arrivalState === "checked-in" ? new Date().toISOString() : null;
    const statement = this.db.prepare(`
      UPDATE check_ins
      SET arrival_state = ?, checked_in_at = ?, desk_note = ?
      WHERE session_id = ?
    `);
    statement.run([
      input.arrivalState,
      checkedInAt,
      input.deskNote ?? "",
      input.sessionId,
    ]);
    statement.free();
    this.persist();
  }

  private calculateWaitlistScore(urgency: string, requestedHost: string): number {
    const urgencyMap: Record<string, number> = {
      high: 90,
      medium: 65,
      low: 40,
    };

    return (urgencyMap[urgency] ?? 40) + (requestedHost ? 10 : 0);
  }

  private deriveArrivalState(
    startsAt: string,
    checkedInAt: string | null,
    storedState: string | null,
  ): string {
    if (checkedInAt) {
      return "checked-in";
    }

    if (storedState === "called" || storedState === "no-show") {
      return storedState;
    }

    const minutesLate = Math.round((Date.now() - new Date(startsAt).getTime()) / 60000);
    if (minutesLate >= 20) {
      return "no-show";
    }

    if (minutesLate >= 5) {
      return "late";
    }

    if (minutesLate >= 0) {
      return "arriving";
    }

    return "scheduled";
  }

  private formatTime(value: string): string {
    return new Date(value).toISOString().slice(11, 16);
  }

  private getRows<T>(query: string): T[] {
    const results = this.db.exec(query);
    if (results.length === 0) {
      return [];
    }

    const [result] = results;
    return result.values.map((valueRow: unknown[]) => {
      const row: Record<string, unknown> = {};
      result.columns.forEach((column: string, index: number) => {
        row[column] = valueRow[index];
      });
      return row as T;
    });
  }

  private hash(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  private hasConflict(session: SessionRow): boolean {
    if (session.booked > session.capacity) {
      return true;
    }

    const results = this.db.exec(
      `
      SELECT COUNT(*) AS overlapCount
      FROM sessions
      WHERE host_name = ${this.escapeSql(session.hostName)}
        AND id != ${session.id}
        AND datetime(starts_at) < datetime(${this.escapeSql(this.endsAt(session))})
        AND datetime(${this.escapeSql(session.startsAt)}) < datetime(starts_at, '+' || duration_min || ' minutes')
    `,
    );

    const overlapCount = Number(results[0]?.values[0]?.[0] ?? 0);
    return overlapCount > 0;
  }

  private escapeSql(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private endsAt(session: SessionRow): string {
    return new Date(
      new Date(session.startsAt).getTime() + session.durationMin * 60_000,
    ).toISOString();
  }

  private matchesWindow(startsAt: string, entry: WaitlistRow): boolean {
    const starts = new Date(startsAt).getTime();
    const from = new Date(entry.preferredWindowStart).getTime();
    const to = new Date(entry.preferredWindowEnd).getTime();
    return starts >= from && starts <= to;
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendee_name TEXT NOT NULL,
        host_name TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        duration_min INTEGER NOT NULL,
        room TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        booked INTEGER NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS waitlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attendee_name TEXT NOT NULL,
        requested_host TEXT NOT NULL,
        preferred_window_start TEXT NOT NULL,
        preferred_window_end TEXT NOT NULL,
        urgency TEXT NOT NULL,
        phone TEXT NOT NULL,
        notes TEXT NOT NULL,
        score INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS check_ins (
        session_id INTEGER PRIMARY KEY,
        arrival_state TEXT,
        checked_in_at TEXT,
        desk_note TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);
  }

  private persist(): void {
    const buffer = Buffer.from(this.db.export());
    fs.writeFileSync(this.filePath, buffer);
  }

  private seedIfNeeded(): void {
    const countResult = this.db.exec("SELECT COUNT(*) FROM users");
    const userCount = Number(countResult[0]?.values[0]?.[0] ?? 0);
    if (userCount > 0) {
      return;
    }

    const userStatement = this.db.prepare(
      "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)",
    );
    const passwordHash = this.hash("nightshift066");
    [
      ["host@seatsprint.local", "Morgan Hale"],
      ["door@seatsprint.local", "Jules Carter"],
      ["attendee@seatsprint.local", "Rina Patel"],
    ].forEach(([email, name]) => {
      userStatement.run([email, name, passwordHash]);
    });
    userStatement.free();

    const now = new Date();
    const makeIso = (minutesFromNow: number) =>
      new Date(now.getTime() + minutesFromNow * 60_000).toISOString();

    const sessions = [
      ["Rina Patel", "Morgan Hale", makeIso(-35), 30, "Studio A", 1, 0, "open"],
      ["Jules Carter", "Morgan Hale", makeIso(-10), 30, "Studio A", 1, 1, "booked"],
      ["Mina Brooks", "Asha Lin", makeIso(20), 20, "Workshop Lab", 2, 1, "open"],
      ["Theo Nguyen", "Asha Lin", makeIso(60), 20, "Workshop Lab", 2, 2, "booked"],
      ["Alma Rivera", "Naima Cole", makeIso(1500), 25, "Main Hall", 1, 0, "open"],
      ["Kai Morgan", "Naima Cole", makeIso(1560), 25, "Main Hall", 1, 1, "booked"],
    ];

    const sessionStatement = this.db.prepare(`
      INSERT INTO sessions (
        attendee_name,
        host_name,
        starts_at,
        duration_min,
        room,
        capacity,
        booked,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      sessionStatement.run(session);
    }
    sessionStatement.free();

    const waitlistEntries = [
      ["Harper Dean", "Dr. Alvarez", makeIso(-60), makeIso(45), "high", "+1 555-0101", "Needs same-day refill clearance.", 100, "waiting", makeIso(-180)],
      ["Noah Singh", "Dr. Shah", makeIso(10), makeIso(200), "medium", "+1 555-0102", "Flexible on room, prefers text first.", 75, "waiting", makeIso(-140)],
      ["Sofia Kim", "", makeIso(30), makeIso(180), "low", "+1 555-0103", "Can take any host after school pickup.", 40, "waiting", makeIso(-90)],
    ];

    const waitlistStatement = this.db.prepare(`
      INSERT INTO waitlist (
        attendee_name,
        requested_host,
        preferred_window_start,
        preferred_window_end,
        urgency,
        phone,
        notes,
        score,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const entry of waitlistEntries) {
      waitlistStatement.run(entry);
    }
    waitlistStatement.free();

    const checkIns = [
      [1, null, null, "Auto-escalate if not confirmed by desk."],
      [2, "checked-in", makeIso(-18), "Vitals in progress."],
      [3, null, null, "Send backfill text if slot remains open at T-10."],
      [4, null, null, "Two-party family visit, keep room together."],
      [5, null, null, "Tomorrow morning hold."],
      [6, null, null, "Insurance card already on file."],
    ];

    const checkInStatement = this.db.prepare(`
      INSERT INTO check_ins (session_id, arrival_state, checked_in_at, desk_note)
      VALUES (?, ?, ?, ?)
    `);

    for (const row of checkIns) {
      checkInStatement.run(row);
    }
    checkInStatement.free();
  }
}
