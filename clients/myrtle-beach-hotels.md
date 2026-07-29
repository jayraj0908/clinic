# Myrtle Beach Hotel Group — Lead Generation + SEO

## Problem (their words)
Want the best lead-gen agent: "someone searches Google for 'host an event
for 500 people in Norfolk' — scrape that person, create a lead." Run it
10–12h/day at scale. Plus SEO so the hotel ranks on top.
**Upside: owner has 100+ hotels if this works.**

## The honest correction (say this in the proposal call)
Nobody — not Google, not any vendor — can identify WHO is typing a search
into Google. Anyone selling "we scrape Google searchers" is selling
something fake or illegal. What their goal actually translates to, using
things that are real:

1. **Capture the searcher at the moment of intent** — Google Ads on
   high-intent event/room keywords ("event venue Norfolk 500 people",
   "wedding block Myrtle Beach"). The searcher clicks, hits a fast lead
   form, and becomes a lead legitimately — same outcome they imagined,
   real mechanism. Our leads agent already ingests Google Ads lead forms.
2. **RFP speed-to-response agent (the actual killer feature)** — event
   planners don't search and hope; they post RFPs on Cvent, Wedding Wire,
   venue marketplaces, and email multiple hotels. An agent that monitors
   RFP inboxes/platforms and responds with a tailored proposal in MINUTES
   (vs. the industry's 2 days) wins deals on speed alone. This is the
   "10–12h/day at scale" engine, done legitimately.
3. **Public-signal monitoring** — people publicly asking for venue
   recommendations (forums, social, event boards) → drafted outreach for
   human approval. Public posts, not private searches.
4. **Instant lead calling** — the moment any lead lands, our calling agent
   phones them within 5 minutes. Speed-to-lead is the highest-ROI move in
   hospitality sales.
5. **SEO content engine** — weekly location/event landing pages, review
   responses, local citations, schema markup. Real SEO, compounding, and
   our marketing agents draft it all for human approval.

## Scope v1 (one hotel, prove it, then the 100)
- Google Ads lead-form capture wired into a Sailz instance (they fund ad
  spend; we build/manage — ads budget is theirs, separate from our fee).
- RFP-response agent: monitors a dedicated rfp@ inbox (they forward
  platform RFPs), drafts tailored responses w/ event-space details,
  human approves → sends. Target: first response < 15 minutes.
- Calling agent: calls every new lead within 5 min, qualifies (date,
  headcount, budget), books a site-visit/call with the sales manager.
- SEO agent: 4 landing pages + review responses/month, drafted → approved.
- Dashboard: leads pipeline, response times, ranking positions, bookings.

## Success metrics (agree BEFORE starting)
- RFP response time < 15 min (industry ~48h)
- Speed-to-lead call < 5 min
- Leads/month and event-booking conversions (baseline first 30 days)
- 3 target keywords moving into top 10 within 90 days (SEO is slow — say so)

## Honest limits
- SEO takes 60–90 days to show movement. Anyone promising "top of Google
  next week" is lying; we won't.
- Ad-driven lead volume depends on their ad budget; we optimize, we don't
  conjure.
- Cvent/platform API access varies; v1 uses the forwarded-inbox pattern
  (works with every platform, zero API dependency).

## Provisioning checklist
- [ ] instances/<hotel-slug>/ — hospitality agent set: leads, rfp-responder
      (new brain file), calling, seo-writer (new brain file), librarian
- [ ] New Railway service, own env/volume/logins
- [ ] Google Ads account access (their Business Manager, us as manager)
- [ ] rfp@ forwarding set up from their platforms
- [ ] Vapi outbound assistant for the calling agent (their branding)
- [ ] Baseline SEO audit (our marketing:seo-audit skill) as the kickoff
      deliverable — impressive, fast, and scopes the content plan

## Pricing note
This is a higher-value engagement than dental: propose setup $2,500–5,000 +
$997–1,997/mo per hotel, with a pre-agreed per-hotel rate card for the
rollout (volume discount at 10+, 25+, 50+). The 100-hotel prize justifies
over-investing in hotel #1.

## Later
Direct Cvent API integration · multi-hotel HQ dashboard (their own mini
Sailz HQ across properties) · dynamic pricing signals · group-block upsells.
