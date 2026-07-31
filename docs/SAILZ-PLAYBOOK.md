# SAILZ — Company & Product Playbook

*Working draft. Business-formation and compliance notes here are orientation,
not legal advice — run the final structure past a lawyer and accountant.*

## 1. What SAILZ is

**SAILZ is an AI automation implementation company.** You sell an outcome —
"your front office runs itself" — delivered as a private, fully-managed AI
brain. The client never touches code. They do a call, tell you their
problems, and two weeks later they log into their own neural map where their
agents are already answering phones, chasing leads, and drafting claims.

The software (this repo) is three things at once: the **delivery vehicle**,
the **demo that closes deals** (the brain map sells itself on a screen
share), and the **moat** (an agency competitor with n8n flows can't show
this, and can't redeploy for a new client in a day).

## 2. What powers it and what it costs you (per client / month)

| Layer | Provider | Est. cost |
|---|---|---|
| Reasoning (notes, coding, qualification) | Claude API | $10–60 |
| Voice calls (STT + LLM + TTS + telephony) | Vapi (+ number) | ~$0.10–0.15/min → $30–200 |
| Calendar, leads, claims | Google / Meta / Claim.MD | ~$0–30 |
| Hosting | Railway → later AWS/GCP | $5–20 |
| **Total COGS** | | **~$50–300** |

Yes — every agent's "thinking" is Claude API. Vapi runs the live phone
conversation (it hosts the voice pipeline; your server is its tool-brain via
webhooks). Your software is the orchestration + memory + dashboard around
those APIs.

## 3. Pricing (productized service — do NOT bill hourly)

- **Setup / implementation fee:** $1,500–3,500 one-time. Covers the
  onboarding call, brain configuration, number provisioning, testing.
- **Monthly retainer per brain:** $497–1,497/mo by tier
  (1 agent → 3 agents → full brain + outbound). Usage included up to a cap.
- Margin at mid-tier: ~$700–900/mo per clinic. 10 clinics ≈ $10K MRR at
  ~75% gross margin. One case study (Shine Dental) funds the next 10 pitches:
  *"one recovered missed call = one $405 visit = the month pays for itself."*

## 4. The external-setup problem (your real question)

Every agent needs outside accounts (Vapi number, Google Calendar, Meta app).
Handle it in two phases:

**Phase 1 — Agency model (start here).** All accounts are created IN THE
CLIENT'S NAME; SAILZ holds admin/manager access:
- Vapi: client org, you're a member. Client card on file (or you rebill).
- Google: client's Workspace; they share the calendar with your service account.
- Meta/Google Ads: their Business Manager; you're an agency partner.

Why: clean HIPAA story (their data, their vendors, BAAs in their name), no
usage-cost risk on your card, and offboarding is removing your access — not
migrating their phone number.

**Phase 2 — Platform model (once repeatable).** SAILZ master accounts with
per-tenant sub-orgs (Vapi orgs, Twilio subaccounts), usage bundled into the
price. Higher margin, one-click provisioning, more liability — do this after
~10 clients.

**The onboarding wizard is the product-ization of this checklist.** Today
setup is manual `.env` editing. Every one of these steps has an API:
- Vapi API: buy number + create both assistants + set server URL → automatic
- Google: OAuth consent screen ("Connect your calendar" button) → automatic
- Meta: app with OAuth → client clicks "Connect Facebook" → automatic
Each integration you automate turns 30 minutes of consulting labor into a
button. That's the road from service company to software company — same
revenue, growing margin.

## 5. How agents connect (they already do)

The brain is a **pipeline over one shared datastore + event log**:

```
ad/webhook → Lead created ──▶ Leads agent qualifies
                                   │
                             calling queue ──▶ Calling agent books ─┐
inbound call ──▶ Receptionist ─── books ────────────────────────────┤
                                   │                                ▼
                             lead saved                    Calendar event
                                                                    │
                              visit happens ──▶ Audit agent (SOAP)  │
                                                     │              │
                                              Billing agent drafts ◀┘
                                                     │
                                          OWNER APPROVES (human gate)
```

Each agent reads/writes the same store and emits activity events (that's
what the map's light pulses will represent). To formalize: add `triggers:`
and `handoff:` fields to each `brain/agents/*.md` frontmatter, and have the
scheduler/webhooks route events by those declarations. New client vertical =
new agent files with different handoffs, same engine.

## 6. Forming the LLC (checklist)

1. LLC in your home state (Delaware only if you'll raise VC). ~$50–500.
2. Registered agent, EIN (free, irs.gov), operating agreement.
3. Business bank account + bookkeeping from day one.
4. Insurance: general liability + **E&O/professional + cyber** (you touch
   patient-adjacent data — this one matters).
5. Contracts (lawyer-reviewed templates): MSA + SOW, **BAA** (HIPAA),
   TCPA compliance clause for outbound calling, AI-disclosure clause.
6. Vendor BAAs: Vapi (HIPAA mode), Google Workspace, Anthropic (check
   current availability for API customers), hosting. Note: for real PHI at
   scale, move hosting from Railway to a HIPAA-eligible host (AWS/GCP).
7. Stripe for billing: setup fee + subscription per brain.

## 7. Sales motion (first 10 clients)

1. Shine Dental = case study #1. Record real numbers for 30 days
   (calls answered after hours, bookings, recovered revenue).
2. Stay in dental until 5 clients. Same brain, same pitch, referenceable.
3. Pitch = 15-min screen share of THEIR brain (seeded with their name,
   services, hours — 30 min of config). The map does the selling.
4. Ask every close for one referral. Dentists know dentists.
5. Then expand vertical-by-vertical (med spas, chiro, law intake) — each is
   just a new `brain/` folder.

## 8. Build roadmap (order matters)

1. ✅ Live brain UI wired to real agents
2. Railway volume + push new UI (in progress)
3. Wire `brain/agents/*.md` into agents.js + brainGraph (files = the brain)
4. Onboarding wizard v1: forms that write clinic-profile.json + .env checks
5. Memory layer (append/retrieve per agent) — "the brain learns"
6. Stripe billing + client-facing weekly report email
7. Postgres multi-tenant when client #3 signs
8. OAuth provisioning (calendar first, then Vapi API, then Meta)
