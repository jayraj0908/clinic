# Prompt for Cursor / Claude Code — Outbound Sales Desk (bulk leads + paced dialer)

For the appointment-setter vertical (client #4: 401k meeting booking).
Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`brain/agents/calling.md`, the Lead Engine code (auto-queue, quiet
hours, DNC), `server/agents.js` (how the setter initiates Vapi outbound
calls), the Leads pipeline tab, `clients/` brief conventions.

## Mission

A client can upload a list of THEIR OWN consented contacts and the
calling agent works it: paced, polite, tracked — until everyone is
booked, declined, or exhausted. Outbound-first vertical support.

## Non-negotiable guardrails (before any code)

1. **Consent attestation at upload**: the uploader must check, per
   batch: "I confirm every contact on this list is an existing client
   or gave prior express consent to be called, and none are on the
   National DNC registry to my knowledge." Store the attestation
   (who/when/filename/count) with the batch. No attestation, no import.
2. All existing calling guardrails apply and cannot be configured away
   by clients: quiet hours (contact-local if timezone known, else
   instance-local), instance DNC list honored + "do not call me" on any
   call adds to it permanently, AI disclosure, max attempts per lead.
3. **Books, never advises**: add a `financial-setter` agent override
   example under instances/_template showing the guardrail pattern —
   scheduling vocabulary only; any product/investment question →
   "great question for [advisor] — let's get you on his calendar."
4. Pacing is server-enforced, not prompt-enforced.

## Stage 1 — Bulk lead import

- Leads tab: "Import leads" (owner) → CSV/XLSX upload → column-mapping
  UI (name, phone, email, company, notes, timezone optional) with
  preview of first 5 rows → attestation checkbox → import.
- Dedupe by phone against existing leads; imported leads get
  source:"import", batchId, status:"new". Import summary (added,
  duplicates, invalid numbers — E.164 normalize, reject malformed).
- Batch view: per-batch progress (queued/calling/booked/declined/
  exhausted/DNC) — this is the client's campaign scoreboard.

## Stage 2 — The dialer loop

- `server/dialer.js`: a paced worker (interval-driven from the
  scheduler) that, while the calling agent is ACTIVE and inside quiet
  hours: picks next eligible lead (new → retry-due), initiates the Vapi
  outbound call (existing pattern in agents.js), marks attempt.
- Pacing config per instance (owner-editable in the calling agent's
  panel, server-clamped to sane maxima): max concurrent calls (default
  1, cap 3), max calls/hour (default 10, cap 30), attempts per lead
  (default 3, cap 5), retry spacing (default: next business day).
- Outcomes from end-of-call reports drive state: booked (→ calendar via
  existing booking flow, confirmation SMS if registered), callback
  requested (schedule retry at asked time), declined (terminal),
  no-answer (retry per policy), do-not-call (terminal + DNC list),
  voicemail (leave ONE scripted voicemail on first attempt only, then
  silent retries).
- Kill switch: pausing the calling agent (catalog toggle) halts the
  loop mid-batch within one tick, always.

## Stage 3 — Visibility

- Batch scoreboard + per-lead call history in the lead drawer (existing
  pattern) with recordings/transcripts.
- weekStats for the calling agent: calls made, connects, meetings
  booked, book rate. The scoreboard IS what this client is buying —
  make the numbers unmissable.
- Heartbeat counts include dialer activity (no PHI, counts only).

## Stage 4 — Verification

```bash
# import: mapping works, dedupe works, bad numbers rejected, attestation
#   stored; import without attestation → 400
# dialer (mock Vapi initiation): respects pacing caps exactly at
#   boundaries, stops outside quiet hours, resumes next window; retry
#   scheduling correct; attempts cap → exhausted
# outcome routing: each end-of-call outcome fixture → correct lead
#   state; "do not call" → DNC + never re-eligible even in a new batch
# pause agent mid-batch → loop halts within one tick
# full regression incl. inbound flows on both live-instance shapes
node --check all changed files
```

## Out of scope

Multi-number rotation, local-presence dialing, voicemail drops beyond
first-attempt script, predictive dialing, any CRM sync (CSV only, v1).
