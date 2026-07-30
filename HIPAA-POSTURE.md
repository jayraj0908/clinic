# HIPAA Posture — Sailz (Shine Dental instance)

This document is written to be shown to a client's compliance person. It
states plainly what patient data this app touches, where it goes, which
vendors will sign a Business Associate Agreement (BAA) today, which won't,
and what technical controls are in place. Last reviewed alongside
`SECURITY-REVIEW.md` (2026-07-28) — read that file for the underlying
technical audit this document summarizes the compliance implications of.

## Is this PHI?

Sailz itself doesn't provide clinical care — it's front-office automation
(scheduling, lead capture, call handling). But once a lead is tied to a real
patient's care (which happens the moment someone books an appointment
through it), the data Sailz holds becomes PHI under HIPAA: it's individually
identifiable health information (name + phone + the fact that they're
seeking dental care + what service + when) held in connection with the
provision of care. **Treat everything below as PHI, not just "contact
info."**

## What we hold

| Data | Where | Notes |
|---|---|---|
| Patient name, phone, email | `db.leads`, `db.appointments` | Core contact record |
| Service requested, appointment time/status | `db.appointments` | |
| Call summaries (AI-generated) | `db.calls` | Free-text — can contain anything discussed on the call |
| **Call recordings** | `db.calls.recordingUrl` — URL only; audio itself lives in Vapi's storage | We store a link, not the audio bytes |
| **Call transcripts** | `db.calls.transcript` | Full text of the conversation, including anything the patient said |
| SMS/email confirmation & reminder content | Sent via Twilio/Resend, not retained in our logs (see below) | |
| Insurance claim codes (CPT/ICD-10) + amounts | `db.claims` | No claim submission is currently wired to a real clearinghouse — see "Not yet integrated" below |

## Where it lives

| Location | What's there | BAA available? |
|---|---|---|
| **Railway** (this app's host — `data/db.json` + `data/backups/`) | Everything in the table above, at rest, unencrypted at the application layer | **No — see Known Gap below.** |
| **Vapi** (voice AI platform) | Call audio, transcripts, call metadata | Yes — Vapi offers a HIPAA-compliant mode/BAA on eligible plans. **Confirm our account is actually on that plan before treating this as covered** — this document assumes it needs verifying, not that it's already true. |
| **Twilio** (SMS) | Phone numbers, message content (booking confirmations/reminders) | Yes — Twilio offers a BAA (enterprise/eligible accounts). |
| **Google Calendar** (via a service account) | Patient name, service, appointment time, in the event title/description | Yes — Google Workspace offers a BAA. |
| **Anthropic** (Claude API — used for chat, visit-note structuring, billing-code suggestions) | Whatever's in the prompt: lead/call/appointment data when the owner asks the chat about it; visit notes when the audit agent runs | Available via Anthropic's sales/enterprise process, not automatic on a standard API key — confirm before relying on it. |
| **Resend** (email) | Patient email, booking confirmation content | BAA availability should be confirmed directly with Resend before relying on it for PHI email. |
| **Meta / Google Ads** | Only pre-appointment lead-form data (name/phone/email a prospect submitted to an ad) | Generally treated as marketing data, not PHI, until the person becomes a patient — but the line is thin. Don't put clinical details in ad lead forms. |

### Not yet integrated (listed as a connector slot, no code touches it)
- **Claim.MD** — appears in the integrations list (`server/seed.js`) as a
  planned connector; no API calls to it exist anywhere in this codebase
  today. The billing agent drafts codes with Claude and stops at
  `awaiting_approval` — there is no automatic clearinghouse submission. When
  this is actually wired up, it needs its own BAA check before going live.

## Known gap: Railway does not offer a BAA

**This is the honest, load-bearing fact of this document.** Railway (the
host this app runs on) does not currently offer a Business Associate
Agreement. That means the plaintext PHI sitting in `data/db.json` on
Railway's infrastructure is not covered by a HIPAA-compliant hosting
relationship today.

**What this means in practice:** for a single early client on a services
agreement with appropriate risk disclosure, this is a common and often
accepted interim posture — but it should not be treated as a solved problem,
and it should not scale past this first client without addressing it.

**Recommendation:** before onboarding a second client, migrate to a
BAA-capable host (AWS, GCP, Azure, or a healthcare-specific PaaS all offer
BAAs) or add a compensating architecture (e.g., encrypt PHI fields at the
application layer before they ever touch the Railway filesystem — this is
explicitly out of scope for the current pass, see `SECURITY-REVIEW.md`
MED-2). Track this as the #1 infrastructure item on the roadmap to a second
client, not a someday nice-to-have.

## Compensating controls now in place

These don't replace a BAA-capable host, but they materially reduce exposure
today (all implemented and verified in this session — see
`SECURITY-REVIEW.md` for the technical detail on each):

- **Authentication**: bcrypt-hashed passwords, JWT sessions, a hard boot
  refusal if `JWT_SECRET` is unset in production, rate-limited login
  (5 attempts/15min/IP), and a constant-time-equivalent login path so
  response timing can't be used to enumerate valid accounts.
- **Webhook authenticity**: Vapi and Meta webhooks verify a signature/secret
  when configured, with a loud boot-time warning when they aren't — so a
  misconfiguration is caught at deploy time, not discovered as an incident.
- **PHI minimization in logs**: the activity feed (readable by every
  authenticated user, not just the owner) masks phone numbers to their last
  4 digits and no longer echoes full SMS/email message content.
- **XSS hardening**: the shared HTML-escaping helper now encodes quote
  characters, closing an attribute-context injection path that webhook-
  sourced data (e.g. a call recording URL) could otherwise have reached.
- **Security headers**: `helmet` with a CSP is now applied to every
  response.
- **Backups**: nightly, on the same volume, last 14 kept — protects against
  data corruption/bad deploys, explicitly **not** a substitute for offsite
  backup or the BAA gap above.
- **Access control**: role-gated routes (owner vs. staff) already existed
  and were verified during this review to correctly withhold `passHash`
  from every API response, with no route found that leaks it.

## What's still open (tracked, not fixed in this pass)

- **DB-stored integration keys (agent catalog, server/catalog.js)**: the
  self-serve "activate an agent" flow lets an owner paste a connector API
  key (Anthropic, Twilio, Resend, Claim.MD, Meta, Google Ads) directly in
  the dashboard instead of setting a Railway env var. That key is stored in
  `db.settings.integrationKeys` — i.e. on the same JSON-file volume as
  everything else, not a secrets manager, and readable by anything with
  filesystem/backup access. This is a deliberate convenience trade-off
  (zero-deploy activation vs. env-var-grade secret hygiene): the UI never
  echoes a stored key back (write-only, masked to last 4 on read), and env
  vars always win when both exist, but a compromised `db.json`/backup now
  also exposes any connector keys entered this way, not just PHI. Treat DB-
  stored keys as acceptable for low-blast-radius connectors (Meta/Google Ads
  tokens, Resend) and prefer real env vars for anything touching PHI-
  adjacent systems (Anthropic, Twilio, Claim.MD) until this gets a proper
  secrets-manager pass.
- No read-access audit logging — the activity log captures *mutations*
  (booked, confirmed, cancelled, claim approved) but not *views*. A stricter
  HIPAA posture logs every PHI read, not just writes.
- Error responses on a few internal routes (`/api/chat`,
  `/api/agents/:id/run`) return raw exception text to the client — low risk
  on an owner/staff-only dashboard, but worth tightening.
- Application-layer encryption of PHI fields at rest — not implemented;
  would meaningfully reduce the impact of the Railway BAA gap above.
- SOC 2 or similar formal compliance tooling — not pursued; out of scope
  until there's a second client and a real compliance timeline.

## Bottom line for a compliance reviewer

Sailz today is appropriate for a single early-stage client under a services
agreement with clear-eyed disclosure of the Railway hosting gap. It is
**not** yet appropriate to represent as "HIPAA compliant" without
qualification — the correct, honest framing is "HIPAA-aware, with named
compensating controls and one identified infrastructure gap that has a
concrete remediation path before scaling to more clients."
