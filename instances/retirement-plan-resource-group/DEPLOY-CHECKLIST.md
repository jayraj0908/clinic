# Retirement Plan Resource Group — Railway Deploy Checklist

New service, same repo (sailz-brain). Outbound-first client — do the
compliance sign-off below BEFORE any real dialing, regardless of how
ready the tech is.

**⚠️ COMPLIANCE GATE — do not skip:** Aman Goel must confirm all outbound
call scripts and the "Retirement Plan Resource Group" business-name usage
with Mutual of America compliance before deployment. Separately, the
calling PROCESS itself (consent basis for the numbers being called, where
the calling list comes from — Form 5500/EFAST public filings and lists
Aman provides — call frequency, quiet hours) needs review against TCPA
rules for AI-generated/prerecorded voices. A compliant script is not the
same thing as a compliant calling process. **Get this signed off in
writing before flipping on real dialing.**

- [ ] Mutual of America compliance sign-off on agents/calling.md's script
      and business-name usage (written, on file)
- [ ] TCPA/consent review of the calling process itself (list source,
      consent basis, frequency, quiet hours) — separate from the script
      review above

## Vapi — never share objects across clients
**Every client's Vapi assistant must use its OWN inline tool definitions
(model.tools, composed via `toolsForVertical()`), never a reference to a
shared/reusable Vapi "Tool" object by ID.** Same for `serverUrl`/
`serverUrlSecret` — always this client's own service URL and this
client's own `VAPI_SERVER_SECRET`, set directly on the assistant, never
inherited from or shared with another client's config. Found live on
2026-08-03 on The Burg's deployment (see that instance's own
DEPLOY-CHECKLIST.md for the full incident) — the account has orphaned
reusable Tool objects sitting on it from earlier dashboard work, so
double-check a fresh assistant's `model.tools` array is fully inline
before going live, not just working today.

## Railway
- [ ] New service from the same GitHub repo (sailz-brain)
- [ ] Volume attached at `/app/data` **BEFORE first boot** — do this
      first, not after; every other instance in this repo lost local
      data the one time this was skipped
- [ ] Custom domain: `rprg.<your-sailz-domain>` (CNAME per Railway)

## Environment variables
```
INSTANCE=retirement-plan-resource-group
NODE_ENV=production
JWT_SECRET=<fresh random 32+ chars — NOT Shine's or Burg's>
VAPI_SERVER_SECRET=<fresh random — set the same value on BOTH Vapi assistants' Server URL secret header>
HEARTBEAT_KEY=<fresh random — matches what HQ polls this service with>
OWNER_EMAIL=<Aman's or the office admin's email>
OWNER_PASSWORD=<generated strong password — hand over at go-live, they change it on first login>
CLINIC_NAME=Retirement Plan Resource Group
CLINIC_TIMEZONE=America/New_York
ANTHROPIC_API_KEY=<yours>
VAPI_API_KEY=<yours>
VAPI_PHONE_NUMBER_ID=<after number import>
VAPI_INBOUND_ASSISTANT_ID=<inbound assistant — see VAPI-SETUP.md>
VAPI_OUTBOUND_ASSISTANT_ID=<outbound dialer assistant — see VAPI-SETUP.md>
GOOGLE_CALENDAR_CREDENTIALS=<service account JSON — real availability needs this; local-fallback calendar logic is conservative/inaccurate without it>
GOOGLE_CALENDAR_ID=<Aman's calendar>
RESEND_API_KEY=<yours>
RESEND_FROM=<confirmations@your-domain>
TWILIO_SID=<yours>            # optional — only if SMS confirmations are wanted alongside email
TWILIO_AUTH=<yours>
TWILIO_FROM=<their number>
VAPI_ASSISTANT_REQUEST=0      # flip to 1 only after a verified test call on the inbound line
VAPI_SYNC_DRY_RUN=1           # keep until the learning loop is trusted for this client
DEMO_MODE=0                   # this client never needs demo/reset — leave off
```

## Post-deploy verification
- [ ] /api/health 200 · dashboard renders with Retirement Plan Resource
      Group name (brandColor is still the engine default — see
      instance.json's `_brandColorNote`; ask the client for a real one)
- [ ] Graph shows ONLY receptionist/calling/librarian — no dental/
      restaurant agents
- [ ] Leads tab: import a small test CSV → mapping/preview/attestation
      flow works → batch scoreboard shows counts
- [ ] Calling agent panel: pacing form shows the conservative defaults
      (1 concurrent / 10 per hour / 3 attempts / 24h retry) — confirmed
      locally, re-confirm on the real deploy
- [ ] Vapi wired per VAPI-SETUP.md — BOTH assistants (inbound +
      outbound), same VAPI_SERVER_SECRET on both
- [ ] Full VAPI-SETUP.md test-call script (10 calls) run and passed —
      #2/#3 (books-never-advises) and #6 (do-not-call → DNC) are the
      ones that must be perfect, not just "close enough"
- [ ] Owner (Aman or office admin) + your logins work
- [ ] Shine + Burg regression: confirm both untouched and healthy

## A2P (required before any customer-facing SMS)
- [ ] This number added to an approved Twilio A2P campaign BEFORE any
      customer SMS goes out (booking confirmations, reminders) — if SMS
      isn't wanted yet, leave TWILIO_* unset and confirmations go by
      email only; note that choice here once decided.

## Go-live (after Aman signs + compliance clears)
- [ ] DEMO_MODE stays off (never needed for this client)
- [ ] Owner password handed over + changed by them on first login
- [ ] First real batch import done WITH Aman/office admin present, so
      they see the attestation step and understand what it means
- [ ] First-week watch: daily check of dialer activity + librarian
      approvals for 7 days after go-live

## Section B — vertical-specific QA (from clients/GO-LIVE-QA.md)
**Sales desk / 401k (client #4)**
- [ ] BOOKS-NEVER-ADVISES: probe with "should I roll over my 401k?" ×3
      phrasings → deflect-to-advisor every time. Zero tolerance.
- [ ] CSV import: mapping, dedupe, bad numbers rejected, attestation stored
- [ ] Dialer: pacing caps hold at boundaries · quiet hours enforced ·
      "do not call me" → permanent DNC → never redialed even from new batch
- [ ] Voicemail once then silent retries · booked meeting lands on the
      advisor's real calendar · pause agent halts loop mid-batch
- [ ] Scoreboard numbers reconcile with call log counts
