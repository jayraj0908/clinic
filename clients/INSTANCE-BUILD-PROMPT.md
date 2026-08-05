# Reusable Cursor prompt — build a client's perfect instance from their onboarding

Fill every <angle-bracket> before pasting. Run AFTER the instance folder
is pulled into git (scripts/pull-onboarding.mjs) and, for outbound-sales
clients, AFTER the Outbound Sales Desk build (prompt 15) has landed.

---

You are working on **Sailz** (this repo). A new client has completed
onboarding and their pulled config lives at `instances/<slug>/`. Your
job is to turn that raw onboarding output into a production-grade
instance — config and instance files ONLY. If you find an engine gap,
stop and report it; never hack engine code inside a client build.

Client: **<Client business name>** · vertical: **<vertical>** ·
what they said they want (verbatim from onboarding): "<paste the goals
free-text>"

Read first: `instances/<slug>/*`, the onboarding draft via the admin API
if fields look thin, `clients/<slug>.md` (create from the brief pattern
if missing), `clients/GO-LIVE-QA.md` (their Section B block),
`instances/the-burg/` (the reference for a well-built instance),
`brain/agents/calling.md` + `instances/_template/`.

## Stage 1 — Normalize the pulled config

- Validate/clean instance.json + clinic-profile.json: every service has
  a name/price/duration where applicable; hours sane; timezone right;
  brandColor set; strip any junk the wizard extraction left.
- Preserve the client's own words: taglines, phrases from their voice &
  tone answers, and the goals text belong IN the config (voice section /
  agent prompt), not paraphrased away.
- `agents` allowlist in instance.json: exactly the roster their goals
  map to — for this client: <e.g. calling, librarian (+ leads if they
  want capture)>. Everything else stays dormant catalog.

## Stage 2 — Their personalized agent(s)

- Write `instances/<slug>/agents/<agent>.md` override(s): base engine
  behavior + their business, tone, and vocabulary from the onboarding.
- For appointment-setter / financial clients this is MANDATORY and
  copies the pattern from instances/_template's financial-setter
  example: **books, never advises** — scheduling vocabulary only; any
  product/investment/medical question → "great question for <advisor
  name> — let's get you on the calendar." Include their greeting, their
  disclosure line, quiet-hours behavior, voicemail script (first
  attempt only), and the exact meeting types + durations they book.
- Frontmatter: correct tools, schedule (null if dialer-driven),
  displayName/color/glyph/tagline so their map reads beautifully.

## Stage 3 — Phone knowledge

- Create `instances/<slug>/vapi-system-prompt.md` with AUTO:MENU /
  AUTO:HOURS / AUTO:POLICIES markers (assistant-request ready), behavior
  sections from the agent override. Verify via a local boot that
  `/api/vapi/preview-prompt` composes correctly and contains their real
  services + zero placeholder text.
- For outbound clients: confirm dialer pacing defaults in their config
  are the conservative ones (1 concurrent, 10/hr, 3 attempts) — the
  owner can raise them later inside server-clamped caps.

## Stage 4 — Local proof

- `INSTANCE=<slug> npm run seed` + boot locally: graph shows ONLY their
  agents + dormant catalog · catalog states correct · their vertical's
  tabs present, others absent · fixture-test their core tool path
  (place_order / book_appointment / dialer eligibility as applicable) ·
  full engine regression untouched (shine + burg unaffected).
- Write `instances/<slug>/DEPLOY-CHECKLIST.md` mirroring the-burg's:
  full env block (INSTANCE, fresh JWT_SECRET + VAPI_SERVER_SECRET +
  HEARTBEAT_KEY placeholders, owner creds note, keys they need),
  volume-first warning, subdomain line, A2P note for their number,
  and their Section B QA block copied in from GO-LIVE-QA.md.

## Stage 5 — Hand back

- Commit instance files only. Then report: what you built, what the
  onboarding data was missing (questions Jay must ask the client), and
  the exact ordered Jay-steps remaining (Railway service, number,
  assistant, QA calls). Update STATUS.md client table.
