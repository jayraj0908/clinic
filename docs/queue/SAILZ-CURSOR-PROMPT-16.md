# Prompt for Cursor / Claude Code — SAILZ 2.0: instant tenancy + Simple Mode

THE big rebuild — the last architectural change before scaling. Run when
no client go-live is in the same week; every stage must leave live
clients untouched until the migration stage is explicitly executed.
Copy below the line. Run ONE stage at a time with review gates.

---

You are working on **Sailz** (this repo): engine + one-service-per-
client, live traffic on Shine + The Burg. Read first: STATUS.md,
`server/instance.js`, `server/store.js` (its own comment says "swap for
Postgres; the API surface is tiny"), `server/brain.js`,
`server/onboarding.js`, `clients/GO-LIVE-QA.md`.

## Mission (two halves, one architecture)

A) **Instant tenancy**: client finishes onboarding → their dashboard
   exists at `<slug>.sailz.org` with emailed credentials, in seconds,
   no human in the loop for the DASHBOARD (phone number stays
   human-approved).
B) **Simple Mode**: a non-technical owner's daily surface — one screen,
   three answers: is my phone answered · what happened today · what
   needs me. The full app (map, catalog, tabs) lives behind "More".

## Hard constraints

1. Migration safety: Shine and The Burg keep working on their current
   dedicated services AT EVERY COMMIT. Multi-tenant mode is a parallel
   path (env `MULTI_TENANT=1` on a NEW service), not an in-place
   rewrite. Cutover per client is explicit, reversible, and last.
2. Postgres for tenant mode (Railway Postgres addon; store.js's API
   surface is the seam — implement a pg-backed store keyed by tenantId
   behind the same functions). JSON-file store remains for legacy
   single-tenant services until each client is migrated.
3. Tenant isolation is absolute: every query scoped by tenantId derived
   ONLY from the request Host header (validated against the tenants
   table) or the authed user's tenant — never from client-supplied ids.
   Cross-tenant access attempts must 404, and get a test proving it.
4. All existing guardrails (approval gates, quiet hours, DNC, pacing
   clamps, admin flag) carry over identically in tenant mode.
5. Brain files stay the catalog source; per-tenant config/overrides move
   to DB rows (files remain the format — stored as text columns).

## Stage 1 — Tenant core (new service, zero client impact)

- Postgres schema: tenants (id, slug, name, vertical, brandColor,
  status, createdAt) + tenant-scoped tables mirroring today's db.json
  arrays + tenant_config (profile/messages/agent-overrides as text).
- pg store implementing store.js's surface with tenantId scoping;
  `MULTI_TENANT=1` selects it. Host-header tenant resolution middleware
  (subdomain → tenant lookup → req.tenant; unknown host → marketing
  placeholder page).
- Boot a second "platform" service locally to verify: two seeded
  tenants on one process, full isolation test suite (auth, data, uploads,
  webhooks — webhook routes resolve tenant by host too, so each tenant's
  Vapi assistant posts to <slug>.sailz.org/webhooks/vapi).

## Stage 2 — Instant provisioning pipeline

- On onboarding completion (tenant mode): auto-create tenant from the
  draft (slug uniqueness enforced), seed config + memory, create owner
  user w/ mustChangePassword, email credentials via notify (RESEND) —
  and land the client on their live dashboard immediately after the
  wizard's last step (magic-link style session into their subdomain).
- Jay's review moves from BEFORE-existence to AFTER: HQ gets a
  "new tenant" attention item; the tenant starts in `sandbox` status —
  dashboard fully usable, Teach/memory usable, but NO phone number and
  outbound features locked until HQ flips status to `approved`
  (the human gate moves to the phone, where the risk lives).
- Wildcard DNS note for Jay-steps: `*.sailz.org` CNAME to the platform
  service (Cloudflare, DNS-only), Railway wildcard domain attached.

## Stage 3 — Simple Mode (the daily surface)

- New default home (all tenants + legacy services, ships everywhere —
  this half is pure frontend and safe): one card stack, mobile-first:
  1. STATUS HERO: "●  Your AI is answering" (or paused/red with one-tap
     reason) + today's counts in plain words: "12 calls · 4 bookings ·
     $1,620 est."
  2. NEEDS YOU: the attention items as big buttons (max 3 shown).
  3. TODAY: reverse-chron feed of plain-language events ("2:14pm —
     booked Alicia, cleaning, Thu 10am") with tap→recording.
  4. One primary action per vertical: restaurant "Today's orders" ·
     clinic "Today's schedule" · sales "Scoreboard".
- Everything else (map, catalog, calls table, calendar, leads, teach,
  settings) collapses under a "More" tab. Map stays one tap away —
  it's the demo jewel, not the daily driver.
- Copy rules: no jargon anywhere on Simple Mode. "Your AI answered" not
  "inbound call handled". Numbers in dollars and counts, never rates.

## Stage 4 — Number provisioning assist (flag NUMBER_PROVISIONING=1)

- On HQ tenant approval: one-click "provision number" = Twilio API buy
  (area code from tenant profile) + Vapi import + assistant create from
  the tenant's composed config (assistant-request mode from birth) +
  webhook URL + secret set — with a confirm screen showing exactly
  what will be purchased/created before executing. Failures roll back
  cleanly (release number if later steps fail).
- A2P constraint surfaced honestly in UI: "texting activates after
  carrier registration" with per-tenant campaign tracking fields.

## Stage 5 — Migration + proof

- Migration script: legacy instance (files+db.json) → tenant rows.
  Dry-run mode printing the diff. Migrate a COPY of Shine into the
  platform service and run the full GO-LIVE-QA Section A against it
  side-by-side with real Shine. Cutover doc: DNS flip per client,
  rollback = flip back (legacy service kept warm 30 days).
- Full regression on legacy mode after every stage (both live shapes).

## Out of scope

Billing/Stripe metering, deleting legacy mode, per-tenant custom
domains beyond subdomains, HQ map constellation of tenants (later).
