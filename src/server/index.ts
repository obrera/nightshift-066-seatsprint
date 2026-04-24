import cookieParser from "cookie-parser";
import express, { NextFunction, Request, Response } from "express";
import path from "node:path";
import { AppDb, SessionUser } from "./db";

type AuthedRequest = Request & {
  user?: SessionUser;
};

const SESSION_COOKIE = "seatsprint-session";

async function main(): Promise<void> {
  const db = await AppDb.create();
  const app = express();
  const port = Number(process.env.PORT ?? 3000);
  const publicDir = path.join(process.cwd(), "dist", "public");

  app.use(express.json());
  app.use(cookieParser());

  app.use((request: AuthedRequest, _response, next) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (typeof token === "string" && token.length > 0) {
      request.user = db.getUserBySession(token) ?? undefined;
    }
    next();
  });

  const requireAuth = (
    request: AuthedRequest,
    response: Response,
    next: NextFunction,
  ) => {
    if (!request.user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };

  app.post("/api/login", (request, response) => {
    const email = String(request.body?.email ?? "").trim().toLowerCase();
    const password = String(request.body?.password ?? "");
    const user = db.login(email, password);

    if (!user) {
      response.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const token = db.createSession(user.id);
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8,
      sameSite: "lax",
    });
    response.json({ user });
  });

  app.post("/api/logout", (request, response) => {
    const token = String(request.cookies?.[SESSION_COOKIE] ?? "");
    if (token) {
      db.deleteSession(token);
    }

    response.clearCookie(SESSION_COOKIE);
    response.status(204).send();
  });

  app.get("/api/session", (request: AuthedRequest, response) => {
    response.json({ user: request.user ?? null });
  });

  app.get("/api/dashboard", requireAuth, (_request, response) => {
    response.json(db.getDashboard());
  });

  app.post("/api/bookings", requireAuth, (request, response) => {
    const attendeeName = String(request.body?.attendeeName ?? "").trim();
    const phone = String(request.body?.phone ?? "").trim();
    const requestedHost = String(request.body?.requestedHost ?? "").trim();
    const urgency = String(request.body?.urgency ?? "medium").trim().toLowerCase();
    const notes = String(request.body?.notes ?? "").trim();
    const sessionId = Number(request.body?.sessionId);

    if (!Number.isFinite(sessionId) || !attendeeName || !phone) {
      response
        .status(400)
        .json({ error: "Session, attendee name, and phone are required" });
      return;
    }

    try {
      response.status(201).json(
        db.createBookingRequest({
          attendeeName,
          notes,
          phone,
          requestedHost,
          sessionId,
          urgency,
        }),
      );
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Booking failed",
      });
    }
  });

  app.post("/api/bookings/:bookingId/state", requireAuth, (request, response) => {
    const bookingId = Number(request.params.bookingId);
    const arrivalState = String(request.body?.arrivalState ?? "scheduled");
    const deskNote = String(request.body?.deskNote ?? "");

    if (!Number.isFinite(bookingId)) {
      response.status(400).json({ error: "Invalid booking id" });
      return;
    }

    try {
      db.updateCheckInState({
        arrivalState,
        bookingId,
        deskNote,
      });
      response.json(db.getDashboard());
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Check-in update failed",
      });
    }
  });

  app.post("/api/bookings/:bookingId/release", requireAuth, (request, response) => {
    const bookingId = Number(request.params.bookingId);
    const releaseReason = String(request.body?.releaseReason ?? "");

    if (!Number.isFinite(bookingId)) {
      response.status(400).json({ error: "Invalid booking id" });
      return;
    }

    try {
      db.releaseSeat(bookingId, releaseReason);
      response.json(db.getDashboard());
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Seat release failed",
      });
    }
  });

  app.post("/api/sessions/:sessionId/backfill", requireAuth, (request, response) => {
    const sessionId = Number(request.params.sessionId);
    const waitlistId = Number(request.body?.waitlistId);

    if (!Number.isFinite(sessionId) || !Number.isFinite(waitlistId)) {
      response.status(400).json({ error: "Invalid backfill request" });
      return;
    }

    try {
      db.applyBackfill(sessionId, waitlistId);
      response.json(db.getDashboard());
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Backfill failed",
      });
    }
  });

  app.use(express.static(publicDir));
  app.get(/^(?!\/api).*/, (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  app.listen(port, () => {
    console.log(`SeatSprint listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
