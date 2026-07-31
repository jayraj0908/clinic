# Prompt for Cursor / Claude Code — Calls Tab + Calendar View

Run after the current chat-actions work is committed and verified.
This is Phases A+B of CLIENT-DASHBOARD-PLAN.md. Copy below the line.

Recommended queue from here: 6 (this) → 3 (memory/Vapi sync) →
4 (onboarding wizard) → 5 (case threads).

---

You are working on **Sailz** (this repo), live on Railway with real phone
traffic. Read first: `CLIENT-DASHBOARD-PLAN.md` (sections 3 and 4),
the Vapi webhook in `server/server.js`, `server/calendar.js`,
`server/notify.js`, `public/index.html` (current dashboard patterns),
`public/brain.html` (design system).

## Hard constraints

1. Route paths and webhook behavior unchanged; additive store fields only.
2. Design system rules apply everywhere (glass panels, serif numerals,
   letter-spaced micro-labels, the one right-drawer pattern, no modals).
3. The calendar view must degrade gracefully: Google unreachable or
   unconfigured → render from local `db.appointments` alone with a quiet
   "showing local bookings" note, never an error screen.
4. Small commits per stage; run verification after each.

## Stage 1 — Capture full call data (backend only)

- In the Vapi end-of-call-report handler, additively store on the call
  row: `recordingUrl` (m.recordingUrl ?? m.artifact?.recordingUrl —
  normalize defensively like normalizeToolCall does), `transcript`
  (m.transcript ?? m.artifact?.transcript), `durationSeconds`
  (m.durationSeconds ?? derived from startedAt/endedAt when present).
  Missing fields → null, never throw.
- Backfill nothing; old rows simply have nulls and the UI handles it.
- `GET /api/calls?filter=&period=` (auth): filters `missed|booked|all`,
  period `today|week|all`; returns calls with the new fields.

## Stage 2 — Calls page

- New "Calls" tab in the dashboard: table rows — direction chip (inbound/
  outbound in agent accent colors), caller, relative time, duration,
  outcome chip, one-line summary. Filters as pill buttons.
- Row click → right drawer: full summary, audio player when recordingUrl
  exists (native <audio>, styled minimal), collapsible transcript,
  linked lead (click-through), action buttons reusing existing routes:
  "Queue callback" (`/api/leads/:id/queue-call`) and "Book" (opens
  calendar tab prefilled — Stage 3).
- Empty states designed, not blank ("No missed calls this week — the
  line is holding.").

## Stage 3 — Calendar view

- `GET /api/calendar/events?from&to` (auth): merge Google events (via
  existing calendar.js service account) with local `db.appointments`;
  dedupe by googleEventId; each event: `{start, end, title, patient,
  service, source: "ai_line"|"outbound"|"manual"|"google", status}`.
- "Calendar" tab: week view (7 columns, business hours from instance
  profile) + agenda list on mobile. AI-booked events get the accent glow
  badge — the constant visual proof the agents are producing.
- "Block time" button (owner): pick day/range + reason → creates a busy
  event via calendar.js; logs to activity; this is also the backing for
  the chat's block_calendar action tool later.
- Clicking an event → the same right drawer: details + "Reschedule"
  (v1: link/instructions, not drag-drop) + cancel with confirmation.

## Stage 4 — Verification

```bash
# fake end-of-call webhook WITH recordingUrl/transcript/duration →
#   call row has all three; WITHOUT them → nulls, no throw
# GET /api/calls filters work (seed a missed + a booked call)
# GET /api/calendar/events with Google unconfigured → local rows only,
#   source flags correct; with fake googleEventId overlap → deduped
# UI: calls table renders, drawer plays a sample mp3 URL, transcript
#   collapses; calendar week view places a seeded appointment in the
#   right day/hour column; block-time creates an activity log entry
# All prior regression checks still pass; node --check changed files
```

## Out of scope

Drag-drop rescheduling, patient-facing calendar links, timezone settings
UI (instance profile only), websockets.
