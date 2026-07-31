# Prompt for Cursor / Claude Code — Chat, Notifications, Confirmations

Copy everything below the line into Cursor's agent at the repo root.
Run ONE stage at a time; verify before moving on.

---

You are working on **Sailz** (this repo): an AI-brain platform, live on
Railway serving Shine Dental Clinic with real phone traffic on the Vapi
webhook. Read first: `CLIENT-DASHBOARD-PLAN.md`, `server/server.js`,
`server/brain.js`, `server/instance.js`, `public/brain.html` (the design
system lives here), `brain/agents/*.md`.

## Hard constraints

1. Never change existing route paths or webhook behavior — live calls flow
   through `/webhooks/vapi`.
2. All frontend work must reuse the existing design system from
   `public/brain.html`: near-black `#050506` background, Cormorant Garamond
   serif for names/numbers, 8–10px letter-spaced uppercase Inter labels,
   glass panels (`rgba(13,13,15,.88)`, 1px `rgba(240,234,216,.09)` borders,
   14px radius), one slide-in right drawer pattern with
   `cubic-bezier(.22,1,.36,1)`, accent colors per agent. No new fonts, no
   new UI patterns, no modals.
3. New outbound messages (SMS/email) must be guarded: feature-flagged by
   env keys being present, never throw if unconfigured, and log every send
   to the activity feed.
4. Small commits, one stage each, verification step run at the end of each.

## Stage 1 — Booking confirmations (SMS + email, server-side)

- Create `server/notify.js` with `sendSMS(to, body)` (Twilio REST, env:
  TWILIO_SID, TWILIO_AUTH, TWILIO_FROM) and `sendEmail(to, subject, html)`
  (Resend API, env: RESEND_API_KEY, RESEND_FROM). Both no-op with a logged
  warning when env keys are missing.
- In the `book_appointment` success path of `/webhooks/vapi`: after the
  appointment row is written, send the patient a confirmation SMS
  ("You're booked at {clinic} — {service}, {date} {time}. Reply here or
  call {number} to reschedule.") and email if an email is on the lead.
  Template strings live in `instances/<id>/messages.json` with engine
  defaults — never hardcode clinic wording in code.
- Reminder cron: daily at 9am instance-local time, SMS every confirmed
  appointment happening the next day. Mark `reminderSentAt` on the
  appointment row (additive field) to prevent duplicates.
- Log every send: `log("notify", ...)`.

## Stage 2 — Attention inbox API + notification bell

- `GET /api/attention` (auth): typed items computed from the store:
  `{type, severity, title, detail, action:{label, method, path}}` for:
  new leads >2h old, unconfirmed appointments, claims awaiting approval,
  missed calls with no follow-up. Include a `count`.
- Small action routes where none exist yet:
  `POST /api/leads/:id/queue-call` (marks lead queued; calling agent's next
  run picks queued leads first), `POST /api/appointments/:id/confirm`.
- Frontend (in `public/index.html` and a bell icon in `brain.html` top
  nav): bell with count badge → glass dropdown listing items, each with its
  one-click action button. Item click-through opens the relevant view.
- Poll every 30s; no websockets yet.

## Stage 3 — Chat with the brain (read-only first)

- `POST /api/chat` (auth): body `{messages:[...]}`. Server-side Claude call
  (reuse the existing Anthropic client pattern from `server/agents.js`)
  with **tool use** over an explicit whitelist of read tools implemented as
  plain functions over the store:
  `get_stats(period)`, `search_leads(q)`, `search_calls(q, filter)`,
  `get_appointments(from,to)`, `get_claims(status)`.
  System prompt: instance profile + "You are {clinic}'s brain. Answer from
  tool results only. Be concise. Amounts in dollars. If asked to take an
  action, say which button in the dashboard does it — action tools come
  later."
- Frontend: a chat drawer using the exact sidebar pattern, opened from a
  button in the top nav (both dashboards). Streaming not required; show a
  subtle typing shimmer while waiting. Keep history in memory per session.
- Rate-limit: 20 chat requests/min per user.
- DO NOT implement action tools (block calendar, run agent) in this pass.

## Stage 4 — Verification (after every stage)

```bash
npm run seed && PORT=3100 node server/server.js &
# statics 200: / , /brain.html
# unauthed 401: /api/attention, /api/chat
# login → GET /api/attention returns well-formed items for seeded state
# POST /api/chat {"messages":[{"role":"user","content":"how many leads do we have?"}]}
#   → answer contains the correct number from the seeded db
# fake Vapi end-of-call-report webhook → still 200, call row created
# with TWILIO_* unset: book_appointment path logs "sms skipped" and does NOT throw
node --check on every changed file
```

## Out of scope

Action tools in chat, websockets, the reporter agent, calendar week view,
calls-tab recordings (separate prompt), any schema-destructive change.
