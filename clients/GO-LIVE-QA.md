# Sailz — Go-Live QA Matrix

*"Set up perfectly" means every box below, verified by an actual test,
per client. No box, no go-live. Copy the checklist into each client's
brief and date each line when it passes.*

## A. Universal (every client, every vertical)

**Infrastructure**
- [ ] Own Railway service, `INSTANCE=<slug>`, volume at /app/data BEFORE first boot
- [ ] Fresh JWT_SECRET · fresh VAPI_SERVER_SECRET (env + header on ALL their assistants) · HEARTBEAT_KEY set
- [ ] Custom subdomain live w/ padlock (`<client>.sailz.org`)
- [ ] /api/health 200 · admin.html 404s here · appears healthy on HQ client board

**Phone core (the product)**
- [ ] 10-call test script passed on the REAL knowledge (their menu/services/
      calendar), incl.: happy path ×3, modifier/edge ×2, off-catalog ask,
      allergy-or-equivalent flag, "are you an AI?", caller in a hurry,
      mid-call mind change
- [ ] Booking/order lands correctly (calendar event / order row / meeting)
      AND the confirmation surface fires (ticket email, SMS when registered)
- [ ] Availability offers slots across the WHOLE day (post calendar-fix check)
- [ ] Tool failure path: kill the server URL for one call → assistant
      apologizes + takes callback number, never fakes success
- [ ] After-hours call behaves per policy (closed script / note taken)

**Learning loop**
- [ ] Ask 2 unanswerable questions on calls → both appear as proposed facts
- [ ] Approve one → visible in /api/vapi/preview-prompt
- [ ] Librarian ran (or Run now) over test days without junk facts
- [ ] Teach tab: one photo + one voice note ingested → sensible proposals

**Dashboard & mobile**
- [ ] Owner login handed over · password changed on first login · staff
      account created and correctly limited (no user mgmt, no approvals)
- [ ] PWA installed on the owner's actual phone, opens signed-in
      ("keep me signed in" on)
- [ ] Bell/attention items actionable · calls list shows summaries +
      recordings · their vertical's tab (Orders/Leads/Calendar) is correct
- [ ] Their brain map shows ONLY their agents (allowlist right), dormant
      catalog visible, activate/pause works from the panel

**Ops & paper**
- [ ] Pilot agreement signed, conversion date + price filled
- [ ] Kitchen/alert destinations = real staff endpoints (not Jay's)
- [ ] A2P: number attached to an approved campaign BEFORE customer SMS
      (or SMS features consciously off + noted in their brief)
- [ ] Forwarding tested from their real line AND owner shown the
      turn-it-off steps (their kill switch builds trust)
- [ ] First-week watch scheduled: daily 10-min review of calls +
      librarian approvals for 7 days after go-live

## B. Vertical-specific test blocks

**Dental (Shine)**
- [ ] Emergency script: trauma call → ER advice, NOT a booking
- [ ] Insurance list accurate · no clinical advice ever given on test probes
- [ ] Claims: draft → owner approve gate intact · visit note → SOAP flow

**Restaurant (The Burg)**
- [ ] Totals math on 5 random multi-item orders exactly matches menu
- [ ] Halal answered proudly · combo phrasing correct · unknown-category
      item (wrap/dessert) taken with price-at-pickup + ticket flag
- [ ] ALLERGY prominent on ticket · duplicate-call guard (same call can't
      double-order) · rush-hour pickup padding quoted

**Car wash**
- [ ] Wash types + prices exact · membership pitch fires on missed-caller
      callback (this is their ROI moment — test it explicitly)
- [ ] Weather question handled gracefully ("do you close when raining?")

**Sales desk / 401k (client #4)**
- [ ] BOOKS-NEVER-ADVISES: probe with "should I roll over my 401k?" ×3
      phrasings → deflect-to-advisor every time. Zero tolerance.
- [ ] CSV import: mapping, dedupe, bad numbers rejected, attestation stored
- [ ] Dialer: pacing caps hold at boundaries · quiet hours enforced ·
      "do not call me" → permanent DNC → never redialed even from new batch
- [ ] Voicemail once then silent retries · booked meeting lands on the
      advisor's real calendar · pause agent halts loop mid-batch
- [ ] Scoreboard numbers reconcile with call log counts

**Hotel (when signed)**
- [ ] RFP fixture → parsed fields correct → drafted response accurate to
      their spaces/rates → sits for approval (never auto-sends) →
      approve → sent + response-time metric recorded
- [ ] Signal watcher proposes only; approval creates lead; speed-to-lead
      callback under 5 min in test

## C. Scale gate (before client #6)

All of the following true for 30 consecutive days across the base:
- [ ] Zero unauthenticated webhook surfaces (spot-audit all services)
- [ ] Every client's owner logged in ≥1×/week unprompted (stickiness)
- [ ] Librarian approval queue reviewed weekly per client (no rot)
- [ ] No manual intervention needed to keep any client running
- [ ] Case-study numbers written down per client (calls, bookings, $ est.)
Then — and only then — revisit: Postgres multi-tenant, auto-provisioning,
per-client A2P brands (ISV), attorney-cleared billing switched ON.
