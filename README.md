# Sailz Brain — engine + instance architecture

An AI front-office platform: an always-on AI receptionist, an outbound
appointment setter, a lead pipeline, visit-note auditing, and insurance
claims with a mandatory human-approval gate — all visualized as a live
"neural brain map" of your agents, and all owner-manageable from one
dashboard with login.

This repo is the **engine**. It is client-agnostic — every fact specific to
a given business (name, hours, services, prompts, branding) lives in
config under `instances/<client>/`, never in engine code. Each real
deployment (one Railway service, one `.env`, one JSON database) is one
**instance** running this same engine.

## Engine vs. instance

- **Engine** (this repo's code): Express API, webhooks, the scheduler, the
  brain-map frontends, the agent-execution logic. Nothing here should ever
  say a specific client's name, hours, or prompt wording.
- **Instance** (`instances/<id>/`): one client's `instance.json` (name,
  vertical, brand color, timezone), `clinic-profile.json` (hours, services,
  insurance, policies — feeds both the dashboard and the voice prompts),
  optional reference copies of the Vapi system prompts, and optional
  per-agent overrides in `instances/<id>/agents/*.md`.
- **The brain** (`brain/agents/*.md`): the engine's default set of agents,
  one markdown file per agent — YAML frontmatter (`name`, `description`,
  `tools`, `schedule`, `model`, plus presentation fields) and a body that
  *is* the agent's Claude system prompt, with a `## Workflows` section the
  brain map reads directly. A new agent is a new file — nothing to wire up
  in code. An instance can override any engine agent by adding a file with
  the same `name` at `instances/<id>/agents/<name>.md`.

## What's inside

```
sailz-brain/
├── server/
│   ├── server.js       # Express API + webhooks + scheduler boot
│   ├── instance.js      # resolves instances/${INSTANCE}/ (default: shine-dental)
│   ├── brain.js          # parses brain/agents/*.md (+ instance overrides)
│   ├── brainGraph.js  # builds the live agent-map JSON from brain.js's agents
│   ├── agents.js          # agent execution; Claude calls use brain-file + instance-knowledge prompts
│   ├── calendar.js     # Google Calendar integration
│   ├── store.js           # JSON datastore (swap for Postgres at multi-tenant scale)
│   └── seed.js             # owner login + settings, sourced from the resolved instance
├── brain/agents/*.md  # the engine's default agents (receptionist, leads, calling, audit, billing)
├── instances/
│   ├── _template/           # copy this to start a new client — see its README
│   └── shine-dental/       # the first real instance (a live dental clinic)
├── public/
│   ├── index.html            # PixiJS "neuron tree" brain map (primary UI)
│   ├── brain.html             # earlier WebGL brain-map prototype (kept working)
│   └── dashboard-classic.html # stat-tile dashboard (agent toggles, CSV export, claims approval)
├── .env.example    # every key slot, documented
└── package.json
```

## Run it locally (5 minutes)

```bash
npm install
cp .env.example .env        # edit: INSTANCE, owner email/password, JWT secret
npm run seed                # creates the database + owner login for the resolved instance
npm start                   # → http://localhost:3000
```

Sign in with the `OWNER_EMAIL` / `OWNER_PASSWORD` from your `.env`. Each
connector you add in `.env` flips that integration to "Connected" and makes
its agent live; nothing is seeded with fake demo data — leads/calls/
bookings only ever come from real webhooks and real calls.

## Creating a new instance (new client)

1. `cp -r instances/_template instances/<client-id>` and follow the
   checklist in that folder's `README.md` — fill in `instance.json` and
   `clinic-profile.json`, optionally override specific agents.
2. Set `INSTANCE=<client-id>` plus that client's own `OWNER_EMAIL`,
   `OWNER_PASSWORD`, `JWT_SECRET`, and connector keys in a new `.env` (or a
   new Railway service's variables — never share a `.env`/database across
   instances).
3. Deploy: new Railway service (or any host) from this same repo. Point
   that client's Vapi Server URL at the new deployment's
   `https://NEW-DOMAIN/webhooks/vapi`.
4. `npm run seed` (or let the auto-seed-on-first-boot guard in
   `server.js` do it) — creates that instance's owner login and empty
   database, isolated from every other instance.

Each instance is a fully separate deployment and database today — this is
intentionally NOT multi-tenant-in-one-process (see Honest limits below).

## Deploy (Railway / Render / any VPS)

1. Push this repo to a private GitHub repo.
2. Railway or Render: new service from repo, add that instance's `.env`
   variables in their dashboard, deploy. You'll get an HTTPS URL — that's
   the domain for all webhook URLs below.
3. Point a client-friendly domain at it (e.g. `client.yourservice.com`).
4. Attach a persistent volume and set `DB_PATH` to a path on it — the
   container filesystem is otherwise ephemeral and a redeploy without a
   volume wipes real accumulated data.

## Connector shopping list (accounts YOU create — keys go in .env, never in chat)

| # | Service | What to do | Feeds |
|---|---------|-----------|-------|
| 1 | **Anthropic** (console.anthropic.com) | Create API key | Every agent's Claude reasoning |
| 2 | **Vapi** (vapi.ai) | Buy a phone number; build 2 assistants: inbound receptionist + outbound setter; set Server URL to `https://DOMAIN/webhooks/vapi` | The dedicated AI number, all calls |
| 3 | **Meta for Developers** | App + Lead Ads webhook to `https://DOMAIN/webhooks/meta`; page access token | Facebook/Instagram leads |
| 4 | **Google Ads** | Lead form asset → webhook `https://DOMAIN/webhooks/google` + key | Google leads |
| 5 | **Google Cloud** | Calendar API service account, share the client's calendar with it | Slot lookup + booking |
| 6 | **Claim.MD** (or Availity) | Account + API key + payer enrollment | Eligibility + claims |
| 7 | **Twilio** (optional) | SMS for confirmations/reminders | Fewer no-shows |

## Compliance (this is what makes it sellable AND safe)

- **HIPAA**: sign BAAs with every vendor touching patient data (Vapi,
  Google, clearinghouse, Anthropic — check current BAA availability per
  vendor). Host on a provider that will sign one too.
- **TCPA**: outbound calls only to form-submitted leads; DNC honored.
- **Billing**: claims require owner approval in the dashboard — the
  Approve button is the legal gate, and is enforced server-side
  (owner-role-only), not just hidden in the UI. Never remove it.
- **AI disclosure**: voice assistants should say they're AI where required
  — verify per state/market before launch (see each instance's
  `clinic-profile.json` `aiDisclosure` field).

## Backups & disaster recovery

`data/db.json` is the only copy of every lead, call, appointment, and claim
— there's no separate database to fail over to. A nightly cron (3am,
instance-local time) gzips it into `data/backups/db-<timestamp>.json.gz` on
the **same** Railway volume, keeping the last 14.

**This protects against:** accidental data corruption, a bad deploy that
mangles `db.json`, or needing to roll back a few days.
**This does NOT protect against:** the Railway volume itself being lost,
deleted, or the project being removed — a same-volume backup dies with the
volume. Before onboarding a second client (or sooner), add an offsite copy:
the simplest option is a small cron/GitHub Action that pulls the latest
`data/backups/*.gz` via `railway ssh` (or a scheduled `railway run` job) and
pushes it to S3/Backblaze/etc. Not implemented here — flagged as the next
real gap to close.

### Restore procedure

1. `railway ssh` (or however you get a shell on the running instance).
2. Pick a backup: `ls -la data/backups/` (newest last).
3. Decompress it: `gunzip -k data/backups/db-<timestamp>.json.gz` — the
   `-k` keeps the original `.gz` in place in case you need to try another one.
4. **Stop the app** (or at least accept a brief window where writes could be
   lost) before replacing the live file: `cp data/backups/db-<timestamp>.json data/db.json`.
5. Restart the app. It picks up the restored file on next `load()` — no
   migration step, since a backup is just a byte-for-byte earlier version of
   the same file.
6. Sanity-check: hit `GET /api/health` (should be `{"ok":true}`), then log in
   and spot-check a few recent leads/appointments look right.

## Honest limits

- One instance = one deployment = one JSON-file database. To run many
  clients from a single process, `store.js` would need a `clinic_id`
  column and a real database (Postgres) — explicitly out of scope until
  this engine/instance refactor has been stable in production for a
  while (see `SAILZ-PLAYBOOK.md` for the build roadmap).
- Webhook signature verification: Vapi (`VAPI_SERVER_SECRET`) and Meta
  (`META_APP_SECRET`, HMAC-SHA256 of the raw payload) are enforced when
  their secret env vars are set, with a boot-time warning when they aren't.
  Google Ads has an equivalent optional key check. None of these are
  mandatory-by-default yet — an instance can still come up before they're
  wired, which is intentional (see `SECURITY-REVIEW.md` CRIT-4), but it
  means it's on you to actually set them before real traffic arrives.
- The onboarding flow for a new instance is still manual file-editing
  (Stage 4 of the refactor); an onboarding wizard that writes
  `instances/<id>/` from a form is a planned next step, not built yet.
- See `SECURITY-REVIEW.md` for the full security audit and
  `HIPAA-POSTURE.md` for what PHI this app holds, where it lives, and which
  vendors do/don't offer a BAA today.
