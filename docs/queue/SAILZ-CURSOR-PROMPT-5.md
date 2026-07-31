# Prompt for Cursor / Claude Code — Case Threads ("watch the agents work")

Run only after PROMPT-4 is merged and verified. Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`server/server.js` (webhook + agent routes), `server/agents.js`,
`server/brain.js`, `public/brain.html`, `CLIENT-DASHBOARD-PLAN.md`.

## Mission

Every unit of work (a lead, an appointment, a claim) becomes a **thread**
— a conversation-style feed where each agent posts as it actually acts,
like a Slack channel for the department. 100% real events, zero
generated chatter. Plus a gated "deliberation" mode where multiple agents
genuinely reason together on complex cases, transcript visible.

## Hard constraints

1. **No theatrical AI.** Thread messages in Stage 1–2 are structured
   records of real actions — never LLM-generated dialogue. Deliberation
   (Stage 3) is real multi-turn reasoning, used ONLY on flagged cases,
   capped at 6 turns, and its output is a proposal for the owner — never
   an autonomous action.
2. Design system rules apply (brain.html aesthetic; threads use the
   slide-in drawer; message bubbles are glass panels with the agent's
   accent color and glyph).
3. Existing routes unchanged; additive store fields only; small commits;
   verify per stage.

## Stage 1 — Thread data layer

- `db.threads`: `{id, caseType: "lead"|"appointment"|"claim",
  caseId, status, messages: [{ts, agent, kind: "action"|"handoff"|
  "note"|"deliberation", text, data?}]}`.
- `server/threads.js`: `postToThread(caseType, caseId, agent, kind,
  text, data)` — creates thread on first post.
- Instrument the EXISTING pipeline (no behavior changes): lead created →
  leads agent posts; qualification → posts + handoff to calling; booking
  (either agent) → posts; confirmation SMS/email sent → posts; visit →
  audit posts; claim drafted → billing posts + handoff to owner;
  approval → owner's action posted. Reuse the wording patterns of the
  activity log; keep messages short and factual.

## Stage 2 — Thread UI

- `GET /api/threads?status=&caseType=` and `GET /api/threads/:id` (auth).
- In both dashboards: clicking a lead/appointment/claim/call opens its
  thread in the right drawer — agent avatar (glyph in accent-color ring),
  name, timestamp, message; handoffs rendered as subtle "passed to →"
  divider lines. Live-poll open threads every 10s.
- On the brain map: when a thread had activity in the last hour, the
  involved agents' hubs get a subtle linked shimmer (reuse the pulse
  system — no new visual language).

## Stage 3 — Deliberation mode (department head, gated)

- New `brain/agents/coordinator.md` (the "department head": glyph ⟐).
  Trigger conditions ONLY: claim flagged `needs_review` with a denial/
  mismatch reason, or a double-booking conflict, or an attention item
  manually escalated via a "Deliberate" button (owner).
- `server/deliberate.js`: coordinator frames the problem, then up to 6
  alternating Claude calls where relevant agents (their brain-file bodies
  as system prompts + case data) each contribute; coordinator synthesizes
  a recommendation. Every turn posted to the thread as
  kind:"deliberation" in real time.
- Output: an attention item "Deliberation complete — recommendation
  ready" with Approve/Reject. Approval executes via existing routes only.
- Cost guard: max 3 deliberations/day (env DELIBERATIONS_PER_DAY),
  skipped with a logged note when Anthropic key missing.

## Stage 4 — Verification

```bash
# seed → simulate: webhook lead + fake booking + fake end-of-call →
#   GET /api/threads shows one lead thread with >=3 messages in order,
#   correct agents, a handoff divider
# claim path: fake visit + billing run → claim thread; approve → owner
#   action appears in thread
# deliberation: flag a fake claim → thread gains <=6 deliberation
#   messages + 1 recommendation; attention item created; daily cap
#   enforced; no Anthropic key → graceful skip
# UI: drawer renders threads in both dashboards; unauthed 401
node --check all changed files; all prior regression checks pass
```

## Out of scope

Free-form agent-to-agent chat, deliberation on routine cases, websockets,
client-visible deliberation controls (owner only).
