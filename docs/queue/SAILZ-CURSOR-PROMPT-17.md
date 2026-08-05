# Prompt for Cursor / Claude Code — RPRG asks: Test Call + Lead Enrichment

Client-driven work for Retirement Plan Resource Group. Ship behind flags,
break nothing for Shine/The Burg. Copy below the line.

---

You are working on **Sailz** (this repo). Two features requested by the
RPRG client. Read first: `server/dialer.js` (the paced dialer — the ONLY
system that places calls), `server/agents.js`, the leads routes and Leads
tab in `public/index.html`, `instances/retirement-plan-resource-group/`,
`brain/agents/signal-watcher.md` (the existing public-signal pattern and
its guardrails), `clients/GO-LIVE-QA.md` financial-services block.

## Hard constraints

1. Every outbound call — including test calls — goes through
   `dialer.js`'s call-placement path. No second calling system, ever.
   (The legacy `setter()` cron path stays deprecated.)
2. Enrichment gathers COMPANY/BUSINESS information only. Never build or
   store personal contact data (personal phones, personal emails, home
   addresses) from web sources, and never let enrichment output become a
   dialable phone number — the dialer's consent gate stays the sole
   source of callable numbers.
3. Feature-flag both: `TEST_CALL_ENABLED=1`, `ENRICHMENT_ENABLED=1`.
   Off by default; enable on RPRG's service only for now.
4. Owner-gated, rate-limited, logged. Small commits, verify each stage.

## Stage 1 — Test Call (the "feels nice" button that must be real)

- Leads tab (and the calling agent's panel): a **Test call** control —
  phone input + optional name + "Place test call" button (owner only).
- `POST /api/dialer/test-call` (owner, `TEST_CALL_ENABLED=1`, rate limit
  3/hour): validates E.164, then places the call **through dialer.js's
  existing call-placement function** with `isTest: true` — same
  assistant, same prompt, same guardrails the client will hear in
  production. Quiet hours DO apply (a test at 11pm still shouldn't
  dial); DNC applies; concurrency cap applies.
- The call is recorded as a lead/call row flagged `test: true` so it
  shows in Calls + the agent's activity WITHOUT polluting real
  scoreboards (exclude `test:true` from weekStats, batch counts, and
  book-rate math — assert this in tests).
- UI feedback is live and honest: "Calling +1…" → "Ringing" → "Answered
  · 0:42" → outcome, driven by the end-of-call report. If Vapi rejects
  the request, surface the actual error text (this is what would have
  caught the voicemailMessage 400 instantly).
- After the call: one-tap "Teach from this call" → sends the transcript
  through the librarian's fact-extraction path so the client's fixes
  from a test call become proposed memory. That's the "train the agent
  from calls" ask, wired to the existing approval loop.

## Stage 2 — Fix the dead leads "Call" button (same code path)

- The existing per-lead call button currently only sets `priorityCall`
  for the deprecated cron agent. Rewire it: enqueue that lead as the
  dialer's next pick (`priority: true`), respecting every guardrail;
  disable the button with a clear tooltip when the calling agent is
  paused or outside quiet hours. Remove the dead flag path.

## Stage 3 — Lead Enrichment (company research, human-gated)

- New `brain/agents/researcher.md` (catalog entry, dormant by default,
  `requires: anthropic` + optional `BRAVE_API_KEY`/`SERPER_API_KEY`).
- `POST /api/leads/:id/enrich` (owner) and a batch variant for an import
  batch: for a lead with a company name/domain, fetch PUBLIC BUSINESS
  info (company site, size/industry signals, locations, recent news,
  plan-relevant context for RPRG: employee count bands, benefits
  provider mentions, growth signals) → Claude summarizes into an
  `enrichment` object on the lead: `{ summary, industry, sizeBand,
  signals[], sources[] }`. **Every claim carries a source URL.**
- Respect robots.txt and per-domain rate limits; cache by domain 30
  days; skip and mark `enrichment: unavailable` rather than guessing —
  hallucinated company facts spoken on a live call are worse than none.
- UI: lead drawer shows an "About this company" card with the summary,
  signal chips, and source links; batch view shows an "Enrich batch"
  action with progress. Nothing auto-dials as a result of enrichment.
- The calling agent may reference enrichment context in its opener
  (e.g. "I see you're a 40-person firm in Richmond") ONLY for leads that
  already carry a consented `consentBasis`. Add that check in the prompt
  composition, and a test proving an unconsented lead can't be dialed.

## Stage 4 — Verification

```bash
# test call: owner-only (staff 403); flag off → 404; bad number → 400;
#   quiet-hours test → refused with clear reason; success → call placed
#   via dialer path (assert single code path), row flagged test:true,
#   excluded from weekStats/scoreboards; Vapi error text surfaced
# teach-from-call: transcript → proposed facts appear in Memory drawer
# leads Call button: enqueues into dialer (assert), disabled states work,
#   no writes to the old priorityCall flag
# enrichment: known-domain fixture → summary + sources; unreachable
#   domain → unavailable, no invented facts; robots-disallowed → skipped;
#   cache hit on second call; batch progress correct
# consent: lead without consentBasis → dialer refuses, enrichment allowed
# full regression: Shine + The Burg unaffected (flags off there)
node --check all changed files
```

## Out of scope

Personal-contact enrichment, paid data providers (Apollo/ZoomInfo) in
this pass, auto-enrich on import (owner triggers it), any change to
Shine/Burg behavior.
