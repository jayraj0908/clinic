# Prompt for Cursor / Claude Code — Memory layer + Vapi knowledge sync

DO NOT run until PROMPT-2 (chat/notifications/confirmations) is merged,
verified, and deployed. Copy everything below the line into Cursor's agent.

---

You are working on **Sailz** (this repo), live on Railway with real phone
traffic. Read first: `server/brain.js`, `server/instance.js`,
`server/agents.js`, `server/notify.js`, `brain/agents/*.md`,
`instances/shine-dental/`, and the Vapi webhook section of `server/server.js`.

## Mission

Make the brain **learn from the business and teach the phone assistant** —
with a human gate. Vapi holds no knowledge of its own: the instance files
are the single source of truth, and the brain pushes updates to the Vapi
assistant via API on approval + weekly.

## Hard constraints

1. Nothing auto-edits what the AI says on live phone calls without owner
   approval. Learning is drafted by AI, activated by a human. Non-negotiable.
2. Never log or echo API keys. Vapi sync must be a no-op with a clear log
   line when VAPI_API_KEY is missing.
3. Existing routes/webhooks unchanged. Additive store fields only.
4. Design system rules from PROMPT-2 apply to any UI.
5. Small commits per stage + verification after each.

## Stage 1 — The librarian agent (learning)

- New `brain/agents/librarian.md` (glyph ⌘, schedule nightly 2am):
  reads the last 24h of calls, leads, and appointments; uses Claude to
  extract DURABLE facts only, each typed:
  - `faq_gap` — callers keep asking something the assistant can't answer
  - `policy_correction` — assistant said something wrong/outdated
  - `preference` — per-patient facts ("prefers Saturday mornings")
  - `signal` — business insight ("5 Invisalign asks this week")
- Output to `db.memory` (new array): `{id, ts, type, fact, source,
  status:"proposed"}`. Dedup semantically (skip if a similar approved/
  proposed fact exists — string-similarity is fine, no new deps).
- Each night's run also creates an attention item: "Brain learned N new
  things — review".

## Stage 2 — Review + approval UI

- `GET /api/memory?status=`, `POST /api/memory/:id/approve` (owner),
  `POST /api/memory/:id/reject` (owner), `POST /api/memory` (owner adds a
  fact manually — the owner teaching the brain directly).
- UI: "Memory" drawer (same slide-in pattern) listing proposed facts with
  type chips and Approve/Reject; approved facts listed below, newest first.
- Approved `preference` facts merge into the lead's record; approved
  `faq_gap`/`policy_correction` feed the knowledge build (Stage 3);
  `signal` facts only appear in reports — never in the phone prompt.

## Stage 3 — Knowledge build + Vapi sync

- `server/vapiSync.js`:
  - `buildReceptionistPrompt()`: compose from (a) engine base
    `brain/agents/receptionist.md` body, (b) instance profile JSON
    rendered to prose, (c) ALL approved faq_gap/policy_correction facts,
    in a clearly marked "Learned knowledge" section.
  - `syncToVapi()`: PATCH the Vapi assistant (env VAPI_API_KEY +
    VAPI_INBOUND_ASSISTANT_ID — add the latter to .env.example) updating
    only the system prompt / knowledge field. Store every pushed version in
    `db.promptVersions` `{ts, hash, prompt, pushedBy}` so any version can
    be inspected and re-pushed (rollback = re-push an old version).
  - Trigger: (a) automatically after any memory approval, debounced 5 min;
    (b) weekly cron Sunday 6pm as a safety re-sync; (c) manual
    `POST /api/vapi/sync` (owner).
- Show sync status in the receptionist agent's sidebar: "Knowledge v{n} ·
  pushed {when}" + a "Push now" button (owner).
- Verify with a dry-run mode first (env VAPI_SYNC_DRY_RUN=1 logs the would-
  be prompt instead of pushing) — default ON until the owner flips it.

## Stage 4 — Verification

```bash
npm run seed && PORT=3100 node server/server.js &
# seed a few fake calls via the Vapi webhook, run librarian manually:
#   POST /api/agents/librarian/run → db.memory gains typed proposed facts
# approve one fact → attention item cleared, promptVersions gains v1 entry
#   (dry-run: log contains the composed prompt, including the approved fact,
#    and does NOT call Vapi)
# reject works; manual POST /api/memory works; non-owner blocked (403)
# unauthed /api/memory 401; all prior regression checks still pass
node --check on every changed file
```

## Out of scope

Editing the Vapi assistant's voice/model settings, mem0/Graphiti (this
file-based memory is v1 and can migrate later), patient-facing memory,
auto-approval of anything.
