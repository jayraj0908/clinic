# Prompt for Cursor / Claude Code — Sailz HQ v1 (the admin becomes SAILZ)

Priority: the Stage 1 hotfix should ship in the NEXT push regardless of
when the rest runs. Copy below the line.

---

You are working on **Sailz** (this repo). Read first: `STATUS.md`,
`server/onboarding.js` + its routes in `server/server.js`,
`public/onboarding-review.html`, `server/instance.js`,
`clients/README.md`, `docs/SAILZ-PLAYBOOK.md` (HQ concept).

## Why

Client instances (Shine, The Burg) currently carry the Sailz-side
onboarding console. Clients must never see provisioning machinery.
Admin capability belongs to a dedicated Sailz HQ instance — Sailz is
the admin, clients are clients.

## Stage 1 — HOTFIX: gate all admin surfaces behind an HQ flag

- New env: `SAILZ_ADMIN=1`. When absent/0:
  - `/onboarding-review.html` → 404 (or redirect to /)
  - ALL `/api/onboarding/create` + `/api/onboarding/admin*` routes → 404
  - the client-facing `/onboard/:token` + its step/complete routes STAY
    working everywhere (tokens created on HQ can point a client at HQ's
    own wizard URL — wizard runs on HQ, not on client instances)
- Client deployments (shine, the-burg) simply never set the flag.
- Verify: without flag, admin routes 404 even as owner; with flag, all
  work as today. Full regression. SHIP THIS IN THE NEXT PUSH.

## Stage 2 — The HQ instance

- `instances/sailz-hq/`: instance.json (name "Sailz", vertical
  "hq", brandColor), profile describing the company, and an `agents`
  allowlist of ["librarian"] for now (HQ's own brain grows later).
- HQ deployment expectations documented in DEPLOY notes: own Railway
  service, `INSTANCE=sailz-hq`, `SAILZ_ADMIN=1`, own volume/JWT/owner
  (Jay). Clients' wizard links now come from HQ's domain.

## Stage 3 — Heartbeats: HQ sees every client

- On every instance: `GET /api/heartbeat` requiring header
  `x-sailz-hq-key: <HEARTBEAT_KEY env>` → returns instance id/name,
  version (git SHA if available), counts (calls/orders/leads/appts this
  week), active agent list, health flags (db writable, last webhook
  seen, last agent run). No PHI — counts and states only.
- On HQ: `db.clients` registry (id, name, baseUrl, addedAt) with owner
  CRUD routes + UI section in the (HQ-only) console: add a client by
  URL+key, HQ polls each client's /api/heartbeat every 10 min and on
  demand; store last 7 days of snapshots.

## Stage 4 — The client board (HQ console v1)

- HQ-only page (extend onboarding-review.html into a proper
  `admin.html` console; onboarding becomes one tab of it):
  - CLIENTS tab: card per client — status dot (healthy/stale/error),
    this-week counts, active agents, last heartbeat, link to their URL;
    MRR field (manual for now) with total MRR shown big.
  - ONBOARDING tab: existing console, unchanged behavior.
  - Same design system. Mobile-usable.
- HQ's brain map can stay as-is for now (client nodes on the map = later
  HQ stage; note it as TODO in STATUS.md).

## Stage 5 — Verification

```bash
# no SAILZ_ADMIN: /onboarding-review.html 404, admin APIs 404,
#   /onboard/:token still serves; full client regression (shine + burg)
# with SAILZ_ADMIN=1 + INSTANCE=sailz-hq: console works, clients CRUD
#   owner-gated, staff 403
# heartbeat: wrong/missing key → 403; correct → counts + no PHI fields
#   (assert no names/phones/transcripts in response)
# HQ polls a mock client (local second server) → board shows healthy;
#   kill it → stale/error state renders
node --check all changed files; update STATUS.md build table
```

## Out of scope

Automated MRR/Stripe, HQ map with client constellations, cross-instance
actions (restart agents remotely), instance-folder git automation on
activate (still manual local flow — documented).
