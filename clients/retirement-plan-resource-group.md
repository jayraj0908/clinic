# Retirement Plan Resource Group — Employer Retirement Plan Consulting

## Problem (their words, from onboarding)
Aman Goel (Mutual of America) needs a way to book complimentary
retirement-plan consultations with employers at scale, without doing
every dial himself. Leads come from a list he provides and from publicly
available employer retirement-plan filings (Form 5500 via the DOL's
EFAST system) — "web scraping" in his own words. This is fundamentally
an outbound-calling business, not an inbound phone-line business.

## Scope v1 — Outbound dialer + inbound backstop
- Outbound: import a CSV of employer contacts (attestation required —
  Aman confirms every contact is an existing client or gave prior
  consent, none on the National DNC registry to his knowledge), the
  dialer works the list: paced, quiet-hours-aware, capped at 3 attempts,
  books straight onto Aman's calendar during the call.
- Inbound: a backstop line for callbacks/referrals, same scheduling-only
  behavior and guardrails as the outbound assistant.
- Both assistants: **books, never advises.** Scheduling vocabulary only —
  any product/investment/fee/plan question gets redirected to "let's get
  you on Aman's calendar," every time, zero exceptions.
- Confirmation: calendar invite + email after booking (their own stated
  preference — no SMS-heavy flow needed, though it's available).

## Compliance — the real scope constraint on this client
This is the first client where "honest limits" isn't a nice-to-have
section, it's the whole reason to slow down before going live:
- Every outbound script needs Mutual of America's compliance sign-off,
  in writing, before deployment — not just the "AI disclosure" line, the
  actual script and business-name usage.
- The calling PROCESS (not just the script) needs a TCPA review: AI-
  generated/prerecorded voices are regulated, so consent basis, list
  sourcing, and call frequency/quiet-hours all need to hold up, not just
  sound polite.
- Zero tolerance on the books-never-advises line. See
  `instances/retirement-plan-resource-group/agents/calling.md`'s full
  guardrail list — it's long on purpose, straight from the client's own
  onboarding answers, and none of it is optional.

## Honest limits (review with Aman before go-live)
- **brandColor is still the engine default** — no real brand color/logo
  was captured during onboarding. Ask before go-live; cosmetic only, not
  a blocker.
- **Hours are the wizard's generic default** (Mon–Fri 9–5) — Aman's real
  availability (M–F + flexible weekends) lives in the calling agent's own
  prompt, but a real Google Calendar connection is what actually drives
  bookable slots. Without it, `check_availability` falls back to a
  conservative local default that may say "closed" on days that are
  actually open — confirmed this is a pre-existing engine behavior (also
  reproduces on Shine Dental locally without calendar creds wired), not
  something specific to this build. Get GOOGLE_CALENDAR_CREDENTIALS
  wired before real test calls, not after.
- **First-attempt voicemail script isn't wired yet** — `server/dialer.js`
  currently sends a hardcoded, generic voicemail message, not the
  personalized script written into `agents/calling.md`. This needs a real
  (small) engine change — reading the script from the instance/agent
  override — before this client's voicemail truly matches their brand.
  Flagged, not hacked around.
- **XLSX import isn't supported** (CSV only) — see server/leadImport.js's
  header comment for why (both available npm packages carry real
  vulnerabilities). Not a blocker; every spreadsheet tool exports CSV.

## Provisioning checklist
- [ ] `instances/retirement-plan-resource-group/` — instance.json,
      clinic-profile.json, messages.json, agents/calling.md,
      agents/receptionist.md, vapi-system-prompt.md, VAPI-SETUP.md,
      DEPLOY-CHECKLIST.md — all done, this build
- [ ] Agent set: receptionist, calling, librarian. No leads agent (their
      two lead sources — Aman's list, web scraping — aren't Meta/Google
      form capture; leads arrive via CSV import instead)
- [ ] New Railway service `retirement-plan-resource-group` from same
      repo, own env, own volume
- [ ] Two Vapi assistants (inbound + outbound) — see VAPI-SETUP.md
- [ ] Google Calendar wired to Aman's real calendar
- [ ] Compliance sign-off (Mutual of America) + TCPA process review —
      BEFORE any real dialing
- [ ] First CSV import done with Aman/office admin present

## Pricing note
Not yet discussed in onboarding — no pricing signal captured. Propose
after a discovery call on call volume (how many employers on a typical
list) and how much of Aman's own calendar this needs to fill.

## Later
Meta/Google lead-form capture if they ever want inbound-generated leads
too (add the `leads` agent) · SMS confirmations (Twilio + A2P) if email-
only confirmation turns out to be insufficient · per-instance voicemail
script support in the engine (see Honest limits above).
