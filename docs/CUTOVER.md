# Cutover runbook — moving a legacy client onto the multi-tenant platform

Moves one existing client (their own dedicated Railway service + volume,
`INSTANCE=<slug>`) onto the shared platform service (`MULTI_TENANT=1`,
`<slug>.sailz.org`) with zero data loss and a fast, deliberate rollback
path. Do this ONE client at a time — never batch cutovers.

The legacy deployment is never modified by any of this. It keeps
running, keeps answering real calls, right up until the DNS flip in
step 5 — and for 30 days after, in case rollback is needed.

## 0. Preconditions

- [ ] Platform service is deployed, healthy, `MULTI_TENANT=1`, `NUMBER_PROVISIONING`
      set per whether this client needs Stage 4's number-assist flow (they
      already have a working number from their legacy deployment — see
      step 4, this is about NOT re-provisioning a number they already have)
- [ ] Wildcard DNS (`*.sailz.org` → platform service) already live and
      verified against a throwaway subdomain
- [ ] `instances/<slug>/` is committed and up to date in this repo (the
      source of truth for `instance.json` / `clinic-profile.json` /
      `messages.json` — see `scripts/pull-onboarding.mjs`'s own header for
      why the repo, not the running deployment, is authoritative)

## 1. Pull a copy of the client's live data

Their real `db.json` lives only on their Railway service's volume — never
in this repo. Pull a COPY (Railway CLI `railway run cat /app/data/db.json`,
or the service's own backup route if one exists) down to a local, non-repo
path. Treat this file as containing real patient/lead PII — local temp
dir only, delete it once cutover is confirmed, never commit it.

## 2. Dry-run the migration

```
DATABASE_URL=<platform's Postgres URL> node scripts/migrate-legacy-tenant.mjs <slug> /path/to/pulled-db.json --dry-run
```

Read the printed counts against what you expect (leads/calls/memory/etc.
roughly matching what the client's legacy dashboard shows). Anything in
the "⚠ arrays not in COLLECTIONS" warning means `tenantStore.js`'s
`COLLECTIONS` list is missing something `db.json` actually uses — fix
that first, don't proceed with data loss silently baked in.

## 3. Run the real migration

```
DATABASE_URL=<platform's Postgres URL> node scripts/migrate-legacy-tenant.mjs <slug> /path/to/pulled-db.json --status=approved
```

`--status=approved` (the default) — this client is already live with a
working number; landing them in `sandbox` would incorrectly re-lock
outbound features they already have.

## 4. Verify before touching DNS

With the platform service reachable locally or on a staging host, hit it
with `Host: <slug>.sailz.org` (curl `--resolve` or `/etc/hosts`, no real
DNS change yet) and confirm, side by side against the still-live legacy
deployment:

- [ ] Owner login works with the migrated credentials
- [ ] `/api/dashboard` — same settings, funnel counts, agent list
- [ ] `/api/brain/graph` — same hubs, same node count
- [ ] `/api/calls`, `/api/attention` — same counts as legacy
- [ ] `/api/vapi/preview-prompt` — any approved memory facts show up
      (proves the learning-loop data carried over, not just static config)
- [ ] `/api/dnc` — the full do-not-call list is present (compliance-critical
      — verify this one explicitly, don't assume)
- [ ] Static/PWA assets (`/`, `/manifest.json`) serve correctly at the
      tenant subdomain

This is GO-LIVE-QA Section A's dashboard/data items, re-run against the
migrated tenant. Section A's PHONE items (10-call test script, A2P
campaign attachment, PWA installed on the owner's real phone) can't be
verified this way — those need the number actually live, which happens
after the DNS flip below, on the client's real phone number.

## 5. The actual cutover (DNS flip)

1. Point `<slug>.sailz.org`'s DNS record at the platform service instead
   of the client's dedicated Railway service.
2. Vapi's assistant for this number already points its `serverUrl` at
   `https://<slug>.sailz.org/webhooks/vapi` (unchanged — the subdomain
   didn't move, only what's behind it did) — no Vapi-side change needed.
3. Make one real test call within a few minutes of the flip. Confirm it
   lands, gets answered correctly, and shows up in the platform tenant's
   `/api/calls`.
4. Watch the platform service's logs for this tenant for the first hour.

## 6. Rollback (if anything looks wrong)

Flip the DNS record back to the client's legacy dedicated service. Their
data there was never touched, so this is a complete, instant revert —
the client is back exactly where they were before step 5, no data to
reconcile. Anything that landed on the platform tenant during the
cutover window (new leads/calls) needs a manual note-and-reconcile if
rollback happens after real traffic — check `/api/calls`/`/api/leads`
timestamps against the flip time.

## 7. Keep legacy warm for 30 days

Leave the client's dedicated Railway service and volume running,
untouched, for 30 days after a clean cutover — cheap insurance against
anything that only surfaces under real production load. After 30 days
with no rollback: decommission the dedicated service, keep the volume's
final `db.json` snapshot archived (not deleted) as the pre-migration
source of truth.
