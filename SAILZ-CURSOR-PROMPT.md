# Prompt for Cursor / Claude Code — Sailz engine refactor

Copy everything below the line into Cursor's agent (Claude) at the repo root.

---

You are working on **Sailz**, an AI-brain platform for small businesses. This
repo is currently a working single-client deployment (Shine Dental Clinic) —
Express backend, JSON datastore, Vapi voice webhooks, Google Calendar, Claude
API agents, and a WebGL "neural brain map" frontend (`public/brain.html`). It
is deployed on Railway and **receiving live phone-call webhooks from Vapi, so
nothing may break**.

## Mission

Refactor from "one clinic app" into **engine + instance** architecture:

- **Engine** = this repo. Client-agnostic. All vertical/client specifics live
  in config, never in code.
- **Instance** = one deployment of the engine for one client (own `.env`,
  own `instances/<client>/` config, own database).

Read these before writing any code: `README.md`, `SAILZ-PLAYBOOK.md`,
`brain/README.md`, `server/server.js`, `server/agents.js`,
`server/brainGraph.js`, `server/store.js`, `server/seed.js`,
`server/knowledge-base/*`, `public/brain.html`.

## Hard constraints

1. Do NOT change any existing API route paths or webhook URLs
   (`/webhooks/vapi`, `/webhooks/meta`, `/webhooks/google`, `/api/*`) — Vapi
   points at the live Railway URL.
2. Do NOT touch the live database schema destructively; migrations must be
   additive with fallbacks to current shape.
3. `public/brain.html` and `public/index.html` must keep working unchanged
   against the same endpoints (`/api/brain/graph`, `/api/brain/agents/:id`,
   `/api/dashboard`).
4. Work in small commits, one stage per commit, and run the verification
   step at the end of every stage before moving on.

## Stage 1 — Instance config extraction

Create `instances/shine-dental/` containing everything Shine-specific:
- Move `server/knowledge-base/clinic-profile.json`, the receptionist and
  setter prompt .md files into it.
- Add `instance.json`: `{ id, name, vertical: "dental", brandColor, timezone }`.
- Add `INSTANCE` env var (default `shine-dental`); a small
  `server/instance.js` loader resolves `instances/${INSTANCE}/` and exports
  the profile + prompts. Update all code that read the old paths to use the
  loader. Keep the old paths working as fallback if the instance folder is
  missing (so the current Railway deploy doesn't 500 before env vars are set).

## Stage 2 — brain/ becomes the source of truth for agents

`brain/agents/*.md` files (already exist: receptionist, leads, calling,
audit, billing) have YAML frontmatter: `name, description, tools, schedule,
model` — and the body is the agent's system prompt.
- Write `server/brain.js`: parse all agent files at boot (gray-matter or a
  tiny hand-rolled frontmatter parser — no heavy deps).
- `server/agents.js`: each agent's Claude system prompt = brain file body +
  instance knowledge merged in. Remove hardcoded prompts.
- `server/brainGraph.js`: build HUBS from brain files (id=name, workflows
  from a `## Workflows` section list, tools from frontmatter) instead of the
  hardcoded HUBS constant. Keep the exact same output JSON shape.
- Support optional `triggers:` and `handoff:` frontmatter fields (store them
  in the graph output as `links kind:"handoff"`); wire the scheduler to skip
  agents whose `schedule` is null (event-driven ones like receptionist).
- Instances may override/extend agents: if `instances/<id>/agents/*.md`
  exists, it wins over `brain/agents/*.md` with the same name.

## Stage 3 — multi-user auth per instance

Currently one owner user from seed. Extend to a proper user list:
- `users` array already exists in the store; add `role` (`owner`|`staff`) and
  support multiple users. Add authed routes: `POST /api/users/invite`
  (owner-only: email + temp password + role), `GET /api/users` (owner-only),
  `POST /api/auth/change-password` (self).
- Seed still creates the owner from OWNER_EMAIL/OWNER_PASSWORD env.
- JWT payload already carries `role` — enforce owner-only on user management
  and on `/api/claims/:id/approve`.

## Stage 4 — rebrand + docs

- Package name → `sailz-brain`; README rewritten around engine/instance
  (how to create a new instance: copy `instances/_template/`, fill
  instance.json + profile, set env, deploy new Railway service).
- Create `instances/_template/` with commented example files.
- Dashboard/UI strings: replace hardcoded "Clinic" defaults with
  `instance.json` name/brand color (brain.html already reads clinicName from
  the API — keep that path working).

## Stage 5 — verification (run after every stage, mandatory)

```bash
npm run seed && npm start &
# then:
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/            # 200
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/brain.html  # 200
curl -s localhost:3000/api/brain/graph                              # 401 (auth intact)
# login with OWNER creds, then GET /api/brain/graph and confirm:
#  - 5 agent nodes with same ids as before (leads, receptionist, calling, audit, billing)
#  - workflows/tools/events present, same JSON shape
# POST /webhooks/vapi with a fake end-of-call-report → 200, call row created
```

Also `node --check` every changed file, and diff the graph JSON before vs
after Stage 2 to prove the shape didn't change.

## Explicitly out of scope (do not attempt now)

Postgres/multi-tenant-in-one-deployment, Stripe billing, OAuth provisioning
wizards, the memory layer. Those come after this refactor is stable and
deployed.
