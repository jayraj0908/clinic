# The Burg — Railway Deploy Checklist

New service, same repo. Do after prompt 8 is merged + reviewed.

**Number purchased: +1 (804) 581-8379** (Twilio, main account — move into a
"The Burg" subaccount when convenient). Status: not yet imported to Vapi,
no assistant yet — deferred until after prompt 4 + batch push.
Pending on this number: add to A2P campaign once campaign is approved.

## Vapi — never share objects across clients
**Every client's Vapi assistant must use its OWN inline tool definitions
(model.tools, composed via `toolsForVertical()`), never a reference to a
shared/reusable Vapi "Tool" object by ID.** Same for `serverUrl`/
`serverUrlSecret` — always this client's own service URL and this
client's own `VAPI_SERVER_SECRET`, set directly on the assistant, never
inherited from or shared with another client's config. Found live on
2026-08-03: The Burg's `VAPI_SERVER_SECRET` drifted from what its
assistant was actually sending, silently 403ing every tool-call and
end-of-call report (a real customer's order never reached the kitchen,
and never showed up anywhere in the dashboard either, since the SAME
check gates both). Root cause that time was a plain secret mismatch, not
actually a shared tool object — but the account does have orphaned
reusable Tool objects sitting on it from earlier dashboard work, and
nothing stops a future assistant from being wired to one by mistake, so
treat this as a standing rule, not just a postmortem note.

## Railway
- [ ] New service from the same GitHub repo (sailz-brain)
- [ ] Volume attached at `/app/data` (BEFORE first boot)
- [ ] Custom domain: theburg.<your-sailz-domain> (CNAME per Railway)

## Environment variables
```
INSTANCE=the-burg
NODE_ENV=production
JWT_SECRET=<fresh random 32+ chars — NOT Shine's>
OWNER_EMAIL=<owner's email>
OWNER_PASSWORD=<generated strong password — hand over at go-live>
CLINIC_NAME=The Burg
CLINIC_TIMEZONE=America/New_York
ANTHROPIC_API_KEY=<yours>
VAPI_API_KEY=<yours>
VAPI_PHONE_NUMBER_ID=<after number import>
VAPI_SERVER_SECRET=<fresh random — set same value in Vapi assistant header>
TWILIO_SID=<yours>
TWILIO_AUTH=<yours>
TWILIO_FROM=+18045818379
KITCHEN_SMS=<kitchen phone, from discovery call>
KITCHEN_EMAIL=<optional>
RESEND_API_KEY=<yours>
RESEND_FROM=<orders@your-domain>
DEMO_MODE=1            # remove at go-live
VAPI_SYNC_DRY_RUN=1    # keep until learning loop is trusted for this client
```

## Post-deploy verification
- [ ] /api/health 200 · /brain.html renders with The Burg name/color
- [ ] Graph shows the order-taker agent set (no dental agents)
- [ ] Fake place_order via curl → order row + kitchen ticket logged
- [ ] Owner + your logins work; staff role tested
- [ ] Vapi assistant wired (see VAPI-SETUP.md) → live test call end-to-end
- [ ] 20-call test script done; fumbles fixed via prompt/memory
- [ ] A2P: Burg number added to your Twilio campaign (or new campaign if
      brand differs) BEFORE customer SMS goes out
- [ ] Shine regression: confirm Shine's service untouched and healthy
- [ ] DEMO: /api/demo/reset works — clean slate for the pitch

## Go-live (after the owner signs)
- [ ] DEMO_MODE removed · owner password handed over + changed by them
- [ ] Owner sets call forwarding from the shop's real line
- [ ] First-week watch: check orders daily, approve librarian facts
