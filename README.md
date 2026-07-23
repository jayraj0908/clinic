# Front Office AI — Clinic Automation Suite

Full-stack, self-hosted product: AI receptionist line, scheduled calling
agents, lead pipeline, visit audit, claims with human approval — all in
one owner dashboard with login.

## What's inside

```
clinic-suite/
├── server/
│   ├── server.js      # Express API + webhooks + scheduler boot
│   ├── agents.js      # 4 agent jobs (uses Claude API when key present)
│   ├── scheduler      # node-cron, driven by each agent's cron schedule
│   ├── store.js       # JSON datastore (swap for Postgres at scale)
│   └── seed.js        # owner login + demo data
├── public/index.html  # owner dashboard (login → live view, 10s refresh)
├── .env.example       # every key slot, documented
└── package.json
```

## Run it locally (5 minutes)

```bash
npm install
cp .env.example .env        # edit: clinic name, owner email/password
npm run seed                # creates the database + owner login
npm start                   # → http://localhost:3000
```

Sign in with the OWNER_EMAIL / OWNER_PASSWORD from your .env.
It works immediately with demo data; each connector you add in .env
flips that integration to "Connected" and makes its agent live.

## Deploy (Railway / Render / any VPS)

1. Push this folder to a private GitHub repo.
2. Railway or Render: new service from repo, add the .env variables in
   their dashboard, deploy. You'll get an HTTPS URL — that's the domain
   for all webhook URLs below.
3. Point a client-friendly domain at it (e.g. dashboard.yourservice.com).

## Connector shopping list (accounts YOU create — keys go in .env, never in chat)

| # | Service | What to do | Feeds |
|---|---------|-----------|-------|
| 1 | **Anthropic** (console.anthropic.com) | Create API key | Note structuring, code suggestions |
| 2 | **Vapi** (vapi.ai) | Buy a phone number; build 2 assistants: inbound receptionist + outbound setter; set Server URL to `https://DOMAIN/webhooks/vapi` | The dedicated AI number, all calls |
| 3 | **Meta for Developers** | App + Lead Ads webhook to `https://DOMAIN/webhooks/meta`; page access token | Facebook/Instagram leads |
| 4 | **Google Ads** | Lead form asset → webhook `https://DOMAIN/webhooks/google` + key | Google leads |
| 5 | **Google Cloud** | Calendar API service account, share clinic calendar with it | Slot lookup + booking |
| 6 | **Claim.MD** (or Availity) | Account + API key + payer enrollment | Eligibility + claims |
| 7 | **Twilio** (optional) | SMS for confirmations/reminders | Fewer no-shows |

## Recommended additions before selling

- **Stripe** — bill your clinic clients monthly for the service itself
- **Google Business Profile** — post-visit review-ask agent (huge for clinics)
- **EHR integration** (Open Dental has an open API; Dentrix/Epic are harder) —
  pulls real visit data instead of manual note drops
- **Multi-tenant**: the datastore is one clinic. To sell to many, move
  store.js to Postgres with a clinic_id column — the API is already
  structured for it.

## Compliance (this is what makes you sellable AND safe)

- **HIPAA**: sign BAAs with every vendor touching patient data (Vapi,
  Google, clearinghouse, Anthropic — check current BAA availability per
  vendor). Host on a provider that will sign one too.
- **TCPA**: outbound calls only to form-submitted leads; DNC honored.
- **Billing**: claims require owner/coder approval in the dashboard —
  the Approve button is the legal gate. Never remove it.
- **AI disclosure**: the voice assistants must say they're AI (several
  states require it).

## Honest limits of v0.1

- JSON datastore = one clinic per deployment (fine for first clients)
- Webhook signature verification is stubbed — add per-provider
  verification before production traffic
- Google Calendar booking call is a slot in agents.js to complete once
  you have the service account
