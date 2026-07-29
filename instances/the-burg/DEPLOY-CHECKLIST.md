# The Burg — Railway Deploy Checklist

New service, same repo. Do after prompt 8 is merged + reviewed.

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
TWILIO_FROM=<the new Burg number>
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
