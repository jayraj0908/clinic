# Sailz HQ — Railway Deploy Checklist

The admin instance, not a client. New service, same repo, same pattern as
every client deployment (its own Railway service + volume + database) —
the only things that make it "HQ" are `INSTANCE=sailz-hq` and
`SAILZ_ADMIN=1`. See `server/server.js`'s `requireHQ` gate: every other
deployment 404s the provisioning console outright; this is the one place
it's actually reachable.

## Railway

- [ ] New service from the same GitHub repo (sailz-brain)
- [ ] Volume attached at `/app/data` (BEFORE first boot) — HQ's own
      database, separate from every client's. `db.onboardings` (the
      wizard tokens/drafts) and `db.clients` (Stage 3's heartbeat
      registry) live only here.
- [ ] Custom domain: hq.\<your-sailz-domain\> (or similar — internal,
      never shown to a client)

## Environment variables

```
INSTANCE=sailz-hq
SAILZ_ADMIN=1
NODE_ENV=production
JWT_SECRET=<fresh random 32+ chars — NOT any client's>
OWNER_EMAIL=<Jay's email>
OWNER_PASSWORD=<generated strong password>
CLINIC_NAME=Sailz
CLINIC_TIMEZONE=America/New_York
ANTHROPIC_API_KEY=<yours — powers the librarian agent + onboarding's
                    brain-dump/interview steps>
HEARTBEAT_KEY=<fresh random string — every client deployment's own
                HEARTBEAT_KEY env must match this exact value; see
                Stage 3, server/server.js's GET /api/heartbeat>
```

No Vapi/Twilio/Resend/calendar keys needed — HQ never takes a real call,
sends a real SMS, or books a real appointment. `instances/sailz-hq/
clinic-profile.json` exists only so the dashboard's profile-reading code
has something valid to load, not because HQ has real hours/services in
the client sense.

## Post-deploy verification

- [ ] `/api/health` 200
- [ ] `/onboarding-review.html` reachable and shows the onboarding
      console (confirms `SAILZ_ADMIN=1` actually took)
- [ ] Spot-check a CLIENT deployment (Shine or The Burg) still 404s
      `/onboarding-review.html` and `/api/onboarding/create|admin*` —
      confirms this flag is genuinely per-deployment, not something that
      leaked
- [ ] Owner (Jay) login works
- [ ] `POST /api/onboarding/create` → real token → `/onboard/<token>`
      wizard loads and completes end to end on THIS domain

## Clients' wizard links now come from HQ's domain

Every new client's onboarding link is minted here
(`POST /api/onboarding/create` → `{url: "https://hq.<domain>/onboard/
<token>"}`) and sent to the client to fill out — the wizard itself runs
on HQ, writing into HQ's own `db.onboardings`, never on the client's
eventual deployment (which doesn't exist yet at that point, and
wouldn't have the admin routes to create a token even if it did). Once
the owner reviews + activates from here, the client gets provisioned as
its own separate Railway service per the usual `instances/_template/
README.md` checklist — that hand-off is still a manual step (see "Out
of scope" in the Sailz HQ prompt: instance-folder git automation on
activate isn't built yet).
