# Client Dashboard v2 — Plan (iterate on this)

Goal: the owner's login stops being "watch the agents" and becomes the place
where money decisions happen in 90 seconds a day. Five surfaces, built in
four phases, all on the existing backend.

## Information architecture

Top nav: **Today · Brain Map · Calls · Calendar · Chat**  (+ bell icon)

### 1. Today (new home tab)
- **Needs-attention inbox** — computed server-side from data already in the
  store, no new infra:
  - leads with status `new` older than 2h → "Call back" button (queues the
    calling agent for that lead)
  - appointments with status `unconfirmed` → "Confirm" / "Reschedule"
  - claims `awaiting_approval` → "Review" (existing approve flow)
  - calls with outcome `missed` and no follow-up → "Have agent call back"
- Endpoint: `GET /api/attention` returns typed items + actions; each action
  maps to an existing route or a small new one (`POST /api/leads/:id/call`).
- 3 stat tiles: calls today, booked today, est. revenue this week.

### 2. Brain Map — as-is (`brain.html`). The wow surface.

### 3. Calls (fix the "not defined properly" log)
- Full-page table: direction chip, caller, time, duration, outcome chip
  (booked / missed / callback / not interested), one-line summary.
- Click a row → drawer: full summary, transcript if available, **recording
  player**, the lead it's linked to, action buttons (call back, book).
- Backend: store `recordingUrl`, `transcript`, `durationSeconds` from Vapi's
  end-of-call report (fields already arrive in the webhook — currently
  dropped). Additive columns, no migration risk.
- Filters: today / week / missed only / booked only.

### 4. Calendar (the core value made visible)
- Build a lightweight **agenda + week view** fed by our own endpoint — not a
  Google iframe (iframes require the viewer's Google login and look foreign).
- `GET /api/calendar/events?from&to`: merges Google Calendar events (via the
  existing service account in `calendar.js`) with local `appointments` rows
  (fallback when Google is down/unconfigured).
- Each event shows: patient, service, source badge ("AI line" bookings get
  the brand glow — constant proof the agents are producing).
- Phase-2 interactions: click empty slot → book manually; drag to
  reschedule → updates Google + notifies patient (Twilio, later).
- "Block time" button → creates a Google busy event (also exposed as a chat
  tool, below).

### 5. Chat — "Talk to your brain"
- Right-side panel (same slide-in pattern as the agent sidebar), available
  on every tab.
- `POST /api/chat`: Claude with tool use over a small, explicit toolbox:
  - read tools: stats, search leads/calls/appointments, get calendar
  - action tools (owner role only): block_calendar_day, run_agent,
    pause_agent, queue_callback(lead)
- Ship read-only first (zero risk, immediately magical:
  "how many new patients this week?"), enable action tools once trusted.
- Every action the chat takes is logged to the activity feed.

### Bell / Notifications
- The bell shows attention items + agent milestones ("Billing agent drafted
  3 claims"). It reads the same `/api/attention` + activity log — the
  Notifications "tab" is just a dropdown, not a separate system.
- Decision: notifications and chat stay **separate but adjacent**. Merging
  them into one "messages" tab muddles "system tells you things" with "you
  ask things" — clunky. The chat can reference notifications ("you have 2
  unconfirmed appointments — want me to have the agent confirm them?").

### Weekly report — yes, an agent does it
- New `brain/agents/reporter.md` — cron Monday 7am: compiles the week
  (calls, bookings, revenue est., wins, one suggestion), writes it as a
  notification AND emails it to the owner.
- Email needs one new config: RESEND_API_KEY (or SMTP) — cheap, 10 min.
- Bonus: the reporter appears as a 6th node on the brain map automatically
  once brain/ wiring is done. The brain visibly grew — great for demos.

## Build order (each phase shippable alone)

| Phase | What | Why first | Effort |
|---|---|---|---|
| A | Calls tab + store Vapi recording/transcript | Owner's #1 daily question: "who called?" | 1–2 days |
| B | Calendar agenda/week view (read-only) | Makes the core value visible | 1–2 days |
| C | Today tab + attention inbox + bell | Turns viewing into deciding | 2 days |
| D | Chat read-only → then action tools | The "alive" feeling | 2–3 days |
| E | Reporter agent + email | Retention insurance | 1 day |

## Rules to keep it from getting clunky
- One interaction pattern everywhere: click → right drawer (calls, agents,
  chat all use it). No modals, no page reloads.
- Every item shows an action, not just information.
- Chat never does silently what a button couldn't do loudly.
- Owner sees dollars, staff sees tasks (role check per tab later).
