# Prompt for Cursor / Claude Code — Lead Engine v1 (Sailz Leads)

Run after catalog Stages 4–6 are done and reviewed. Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`clients/myrtle-beach-hotels.md` (the legit lead-gen model — REQUIRED
reading: we never claim to identify searchers; sources are ads, RFPs,
and public signals), `server/notify.js`, `server/brain.js`,
`server/catalog.js`, the leads/attention routes in `server/server.js`.

## Mission

A lead engine any instance can activate: leads flow in from legitimate
sources, get qualified, and trigger an instant callback — because
speed-to-lead is the product. Hotels add RFP response; everyone gets
capture + instant call.

## Hard constraints

1. Every automated outbound contact respects the existing guardrails:
   form-submitted/inbound leads only, quiet hours 8am–8pm local, DNC
   honored, disclosure. No purchased lists, no scraped personal contact
   info of individuals. Public-signal leads are PROPOSED to the owner,
   never auto-contacted.
2. All new agents ship as catalog entries (requires/Results/tagline) —
   dormant by default, activated per client via the store.
3. Additive store fields only; existing routes unchanged; small commits;
   verify per stage.

## Stage 1 — RFP inbox agent (the hotel wedge)

- Inbound email → lead: `POST /webhooks/email` accepting Resend inbound
  webhook format (env RESEND_INBOUND_SECRET verifies; also accept a
  generic {from, subject, text} JSON for forwarded-mailbox setups).
- New `brain/agents/rfp-responder.md` (catalog: requires resend,
  anthropic): on inbound email, Claude extracts {event date, headcount,
  budget hints, space needs, contact, deadline} → creates lead
  (source:"rfp", type:"rfp", parsed fields) → drafts a tailored response
  from the instance profile (spaces, capacities, rates from profile) →
  saves as draft awaiting owner approval (attention item: "RFP from X —
  response drafted, review & send"). Approve → sends via notify.sendEmail
  with the drafted reply. Track elapsed time from received→sent; show it
  ("responded in 11 min") — that metric IS the product.
- Malformed/non-RFP email → logged, skipped gracefully.

## Stage 2 — Speed-to-lead auto-queue

- Instance setting `autoCallNewLeads` (default off; toggle in the
  calling agent's panel): any new lead with a phone (webhook, RFP, or
  manual) → if calling agent active and inside quiet hours → auto-queued
  for callback; outside hours → queued for next morning + flagged.
- Lead row gains `firstContactAt`; leads list + agent Results show
  median speed-to-lead. Target metric on the panel: "< 5 min".

## Stage 3 — Signal watcher (proposed leads, human-gated)

- New `brain/agents/signal-watcher.md` (catalog; requires anthropic;
  optional BRAVE_API_KEY for web search — no key → RSS/URL watchlist
  only): per-instance watch config (queries/feeds, e.g. "wedding venue
  Norfolk", local event boards). Daily run: fetch → Claude filters for
  genuine buying signals → creates PROPOSED leads (attention item), each
  with source link. Owner approves → becomes a real lead (which may then
  auto-queue per Stage 2). Never contacts anyone directly.
- Public business info only; skip anything resembling personal data
  harvesting of private individuals.

## Stage 4 — Lead pipeline that works on a phone

- Leads tab upgrade: pipeline states new → contacted → booked → won/lost
  as swimlane chips (mobile: stacked list w/ status filter). One-tap per
  lead: Call now (queue), Mark booked, Lost. Every lead shows source
  badge + speed-to-lead.
- The three lead agents (leads, rfp-responder, signal-watcher) feed the
  brain map's activity like everything else.

## Stage 5 — Verification

```bash
# inbound RFP email fixture → lead created w/ parsed fields, draft
#   attached, attention item; approve → email send logged, elapsed-time
#   recorded; bad secret → 403; junk email → skipped, no throw
# new webhook lead with autoCallNewLeads on → queued (inside hours),
#   flagged-for-morning (outside hours — fake the clock)
# signal-watcher run with a fixture feed → proposed leads w/ links;
#   nothing contacted; approve → normal lead
# catalog: all three appear w/ correct requires/states on a fresh
#   instance; dormant by default
# quiet hours + DNC guardrails covered by tests; full prior regression
node --check all changed files
```

## Out of scope

Google Ads API automation (webhook capture already exists), paid data
providers, auto-sending RFP responses without approval, SMS outreach.
