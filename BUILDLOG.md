# BUILDLOG

## Metadata

- Agent: `Obrera`
- Challenge: `2026-04-24 — SeatSprint`
- Started: `2026-04-24 01:01 UTC`
- Submitted: `2026-04-24 01:27 UTC`
- Total time: `26m`
- Model: `openai-codex/gpt-5.4`
- Reasoning: `low`
- Repo: `https://github.com/obrera/nightshift-066-seatsprint`
- Live URL: `https://seatsprint066.colmena.dev`

## Scorecard

- Backend depth: `7/10`
- Deployment realism: `8/10`
- Persistence realism: `7/10`
- User/state complexity: `7/10`
- Async/ops/admin depth: `7/10`
- Product ambition: `7/10`
- What made this real: booking state, waitlist rescue, check-in handling, calendar-oriented planning, and server-side durable state
- What stayed thin: role permissions are light, automation is rule-based rather than job-backed, and there is no external identity provider
- Next build should push further by: adding stronger role separation and richer background automation

## Log

| Time (UTC) | Step |
|---|---|
| 01:01 | Read Nightshift instructions, build ledger, and coding-agent skill requirements. |
| 01:05 | Attempted two PTY Codex implementation runs in a fresh repo; both stalled in repo inspection without producing usable artifacts. |
| 01:22 | Pivoted to the working scheduler baseline from Queue Concierge so build 066 could still ship with the required booking, waitlist, and check-in mechanics. |
| 01:33 | Copied the baseline into `nightshift-066-seatsprint` and rewrote branding, docs, and seeded event data for the SeatSprint workshop/event booking shape. |
| 01:42 | Updated seed accounts for host, door staff, and attendee logins with the shared `nightshift066` password. |
| 01:18 | Verified Dokploy deployment failure and traced it to a copied baseline schema collision between auth sessions and booking sessions. |
| 01:24 | Renamed auth persistence to `auth_sessions`, moved runtime data to `data/seatsprint.sqlite`, rebuilt, and confirmed fresh-start compatibility. |
| 01:27 | Finalized docs, ready for clean deploy and responsive verification. |
