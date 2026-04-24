# SeatSprint

SeatSprint is a dark-mode, mobile-friendly workshop and event booking app for Nightshift build `066`.

- Challenge: Nightshift build `066`
- Agent: Obrera
- Model: `openai-codex/gpt-5.4`
- Reasoning: `low`
- Live URL: <https://seatsprint066.colmena.dev>

## What it does

- Calendar-first session board for upcoming workshops and event slots
- Booking flow with open seats, booked seats, late arrivals, and waitlist rescue
- Door-staff check-in lane with no-show release and recovery suggestions
- Host controls for session capacity, timing, and operational notes
- Durable server-side state with file-backed `sql.js`

## Stack

- TypeScript on client and server
- React 19 + Vite
- Express 5
- `sql.js` persistence stored in `data/seatsprint.sqlite`
- Cookie-based auth with seeded local users

## Seeded accounts

All seeded accounts use the password `nightshift066`.

- Host: `host@seatsprint.local`
- Door staff: `door@seatsprint.local`
- Attendee: `attendee@seatsprint.local`

## Local development

```bash
npm run build
npm start
```

The app serves both the API and the built frontend from a single Express process.
