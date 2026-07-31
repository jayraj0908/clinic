# Prompt for Cursor / Claude Code — Agent Catalog: plug-and-play activation

Copy below the line. Run stage by stage. This turns the map into the
product: every agent visible, described, and switchable on/off by the
client — dormant agents are the upsell surface.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`server/brain.js`, `server/instance.js`, `server/agents.js`,
`server/server.js` (bootSchedules + agents routes), `brain/agents/*.md`,
`instances/the-burg/instance.json`, `public/brain.html`, `public/index.html`.

## Product model

- `brain/agents/*.md` = the FULL catalog every client can see.
- Per instance, each agent is in one of four states:
  `active` (on, scheduled/live) · `paused` (activated but toggled off) ·
  `available` (requirements met, one click to activate) ·
  `needs_setup` (missing integration keys — show exactly which).
- The client activates/deactivates agents themselves. No code, no deploys.

## Hard constraints

1. Existing routes/webhooks unchanged; live Shine traffic must not break.
2. Activation state must survive redeploys → store it in the DB (volume),
   NOT in instance.json (code dirs are rebuilt from git on every deploy).
   Precedence: db.activeAgents (if set) > instance.json allowlist > all.
3. API keys entered via UI are owner-only, write-only (never echoed back
   in full — masked to last 4), stored under db.settings.integrationKeys,
   and env vars always take precedence when both exist. Add a note to
   HIPAA-POSTURE.md that DB-stored keys are a convenience trade-off.
4. Design system rules apply. Small commits per stage + verification.

## Stage 1 — Catalog metadata in the brain files

Add to every `brain/agents/*.md` frontmatter (and the parser):
- `tagline:` one line for cards/tooltips (some files have it already)
- `requires:` comma list of integration ids it needs (vapi, gcal,
  anthropic, twilio, resend, claimmd, meta, gads — match store.js ids)
- and a `## Results` section in the body: 3–4 bullets of what the client
  will SEE when this agent runs ("Missed calls answered 24/7", "Every
  booking lands in your calendar with a confirmation text", …).
Write honest, client-facing copy for all existing agents.

## Stage 2 — Catalog API + activation

- `GET /api/catalog` (auth): every engine+instance agent with:
  id, name, tagline, description, workflows, results, requires[], and
  computed `state` + `missing[]` (which requirements lack BOTH env and
  db keys) + live counters (runs this week from activity, lastRun).
- `POST /api/catalog/:id/activate` (owner): requirements met → add to
  db.activeAgents, create db.agents runner row if the brain file has a
  schedule (default on), re-arm schedules, log activity "Agent X
  activated by owner". Requirements missing → 400 with missing[].
- `POST /api/catalog/:id/deactivate` (owner): sets paused (runner off,
  schedule disarmed). Deactivation never deletes data or history.
- `POST /api/integrations/keys` (owner): `{id, key}` → stores in
  db.settings.integrationKeys; `GET /api/integrations` returns each id
  with connected:true/false and maskedKey ("••••1234") — never the value.
- brain.js + bootSchedules honor the DB-backed active set; graph shows
  active+paused agents as hubs. Full regression after this stage.

## Stage 3 — The map becomes the store

- Map: ACTIVE agents render as today. INACTIVE catalog agents render as
  **dormant hubs** — dimmed ring, no branches, small "+" glyph, subtle
  slow pulse — placed in the ring layout with the rest, so the client
  sees the shape of everything their brain COULD do.
- Clicking any hub (active or dormant) opens the agent panel:
  - name, tagline, description, "What you'll get" (Results bullets)
  - requirements checklist: ✓ Connected / ✗ Needs key — with an inline
    owner-only field to paste the key right there (posts to
    /api/integrations/keys, rechecks state live)
  - the big toggle: Activate / Pause — a real switch, instant feedback;
    on activate, the hub lights up and grows its skill branches on the
    map WITHOUT a reload (rebuild that dept's nodes in place)
  - live results when active: runs this week, lastRun, latest activity
- Workforce tab: same catalog as cards with the state chip + toggle.

## Stage 4 — Results made visible per agent

- Each agent panel gets a Results strip driven by real data per agent
  type: receptionist → calls answered/booked this week; calling → calls
  made/booked; billing → claims drafted/$; audit → notes structured;
  leads → leads captured by source; librarian → facts proposed/approved.
  Compute in brainGraph/agentDetail server-side (`weekStats`), not in
  the frontend.
- Empty states sell, not shame: "Activate to start capturing every
  after-hours call" instead of "no data".

## Stage 5 — Onboarding tie-in

- The onboarding review/activation screen (from the wizard) shows the
  catalog with recommended agents pre-checked per vertical
  (instances/_template gains `recommendedAgents` in instance.json).
  Activating a client = their brain boots with those on; everything else
  visible as dormant.

## Stage 6 — Verification

```bash
# GET /api/catalog: all brain-file agents present with computed states;
#   an agent whose `requires` lacks keys → needs_setup + missing list
# activate an available agent → 200, db.activeAgents grows, schedule
#   armed, graph gains the hub; deactivate → paused, schedule gone,
#   graph keeps hub (paused), history intact
# activate with missing reqs → 400 { missing:[...] }
# POST key → GET /api/integrations shows connected + masked, never full;
#   staff blocked (403) from activate/deactivate/keys
# redeploy simulation: rm -rf a copied instances allowlist → boot →
#   active set still correct from DB
# Shine full regression; INSTANCE=the-burg: dormant agents visible in
#   catalog, only receptionist+librarian active
# UI: dormant hub renders dimmed; activating from the panel grows
#   branches without reload; key field posts and flips ✗→✓ live
node --check all changed files
```

## Out of scope

Billing/metering per agent (Stripe later), per-agent pricing display,
marketplace for third-party agents, encryption-at-rest for stored keys
(documented trade-off for now).
