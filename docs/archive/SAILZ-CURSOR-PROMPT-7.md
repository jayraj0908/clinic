# Prompt for Cursor / Claude Code — Security & HIPAA Hardening (Stage 0, overdue)

Run this BEFORE prompts 3–6 — hardening outranks features. Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway with real phone
traffic and patient-adjacent data (names, phones, appointments — PHI under
HIPAA once tied to care).

## Step 1 — Review with the ECC reviewer agents (do this first, no code)

The `ecc/` folder vendors Everything Claude Code. Adopt each of these agent
definitions as a review lens and run the FULL codebase (`server/`,
`public/`, `brain/`, `instances/`) through each, producing
`SECURITY-REVIEW.md` with findings by severity (critical/high/medium/low):

- `ecc/agents/security-reviewer.md`
- `ecc/agents/healthcare-reviewer.md`
- `ecc/agents/code-reviewer.md`
- `ecc/agents/database-reviewer.md`

Include at minimum an assessment of: auth/JWT handling, webhook
authenticity, injection surfaces, PHI in logs and API responses, error
leakage, dependency risk (`npm audit`), and data-at-rest exposure.

## Step 2 — Fix the known criticals (confirmed present)

1. **JWT secret fallback**: `SECRET = process.env.JWT_SECRET ||
   "dev-secret-change-me"` — in production (NODE_ENV=production or
   RAILWAY_ENVIRONMENT set), refuse to boot without a real JWT_SECRET.
2. **Webhook authenticity**: VAPI_SERVER_SECRET is optional-if-set —
   log a prominent boot warning when unset; document setting the secret
   header in Vapi. Meta webhook: implement X-Hub-Signature-256 HMAC
   verification when META_APP_SECRET is set. Google: keep key check,
   warn when unset.
3. **Rate limiting**: express-rate-limit (the one allowed new dep) —
   strict on `/api/auth/login` (5/15min/IP) and `/api/chat` (20/min),
   moderate on webhooks (sane burst ceiling).
4. **helmet** (second allowed dep) with a CSP compatible with brain.html
   (self + cdnjs + fonts.googleapis/gstatic; no inline-script ban
   regressions — test the map still renders).
5. **PHI in logs**: activity log currently writes full phone numbers
   (e.g. "queued for callback" / "called in" lines). Mask to last-4
   everywhere in `log()` calls. Audit every `log(` call site.
6. **Auth responses**: verify no endpoint ever returns passHash (grep all
   `res.json` sites); ensure login failure is uniform (no user-exists
   oracle).
7. **npm audit** — fix or document every high/critical.

## Step 3 — Data-at-rest + backup

- `data/db.json` is plaintext on the Railway volume. Add a nightly backup
  job: gzip db.json → keep last 14 in `data/backups/` (same volume) AND
  document (README section) the restore procedure + the recommendation to
  add offsite backup before client #2.
- Add `GET /api/health` (unauthed, no data): `{ok, version, dbWritable}`
  for uptime monitoring.

## Step 4 — Document the HIPAA posture honestly

Create `HIPAA-POSTURE.md`: what data we hold (contact + appointment +
call summaries/transcripts = PHI), where it lives (Railway volume, Vapi
cloud, Twilio, Google Calendar, Anthropic API), which vendors offer BAAs
(Vapi HIPAA mode, Twilio, Google Workspace, Anthropic via sales) and
which do NOT (Railway — flag as the known gap requiring migration to a
BAA-capable host as PHI volume grows), plus the compensating controls now
in place. This file is what we show a client's compliance person.

## Verification

```bash
# boot with NODE_ENV=production and no JWT_SECRET → refuses to start
# 6 rapid failed logins → 429
# webhook with wrong x-vapi-secret (secret set) → 403; without secret
#   env → warning logged at boot, webhook still works
# activity log entries show phones as ***-1234 only
# /api/health 200 {ok:true}; backups dir gains a file after job runs
# brain.html still renders fully under helmet/CSP (manual check)
# all prior regression checks pass; npm audit shows no high/critical
```

## Out of scope

Postgres migration, encryption-at-application-layer, SOC 2 tooling,
offsite backup implementation (documented only).
