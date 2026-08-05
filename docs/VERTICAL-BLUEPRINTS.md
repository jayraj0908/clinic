# Sailz — Vertical Blueprints

*One vertical = one blueprint = one shape of brain. A blueprint decides
three things: which agent is **the product** for this business, which
agents support it, and which dashboard tabs exist. Everything else stays
hidden.*

This file is the human-readable source. `brain/blueprints/<vertical>.json`
is the machine copy the engine reads (Cursor prompt 19 creates it). When
they disagree, this file is right and the JSON is a bug.

---

## The principle: one primary agent, everything else supports it

Every client bought **one thing**. Shine Dental bought "the phone gets
answered." RPRG bought "someone calls my list." Myrtle bought "RFPs get
answered before the competition wakes up." The primary agent is that
thing. It sits at the centre of their map, it's the hero of their
dashboard, and it's what the monthly report is scored on.

Supporting agents exist to make the primary one better — the Librarian
so it learns, the Researcher so it knows who it's talking to, Leads so
it never runs dry. They are visible on the map but they are not the
pitch.

**A tab only exists if the primary agent produces something to put in
it.** No calendar for a restaurant. No orders for a dental clinic. No
leads tab for a business that doesn't do outbound. That's what makes a
dashboard feel built-for-you instead of cluttered.

---

## Blueprint: `dental` — *the phone gets answered*

**Live example:** Shine Dental (Richmond) · **Plan:** Business

| | |
|---|---|
| **Primary agent** | `receptionist` — inbound AI phone line |
| **Supporting** | `librarian`, `leads`, `calling`, `researcher` (dormant) |
| **Optional** | `audit`, `billing` (only if they want clinical notes + claims) |
| **Tabs** | `dash` · `calls` · `leads` · `calendar` · `teach` · `work` |
| **Hidden** | orders |
| **Scored on** | calls answered %, appointments booked, after-hours capture |

The buying trigger is a missed call at 6pm on a Friday. Lead with
after-hours capture, not with AI.

Compliance: HIPAA posture (`HIPAA-POSTURE.md`), PHI masking on, no
clinical advice ever, AI disclosure on request.

---

## Blueprint: `restaurant` — *orders get taken during the rush*

**Live example:** The Burg (Richmond) · **Plan:** Business

| | |
|---|---|
| **Primary agent** | `receptionist` — inbound line, takes pickup orders |
| **Supporting** | `librarian`, `rfp-responder` (catering/events, dormant) |
| **Tabs** | `dash` · `calls` · `orders` · `teach` · `work` |
| **Hidden** | calendar, leads |
| **Scored on** | orders captured, average ticket, calls missed during peak |

Menu and prices live in `clinic-profile.json` and are the single source
of truth for what the agent can sell. Allergy flags escalate to a human,
always. Never quotes a wait time it can't verify.

Removing the Leads and Calendar tabs from The Burg is the first job of
this blueprint — a restaurant owner does not want a pipeline board.

---

## Blueprint: `financial-services` — *someone works my list*

**Live example:** Retirement Plan Resource Group (Aman Goel) · **Plan:** Solo

| | |
|---|---|
| **Primary agent** | `calling` — the paced outbound dialer |
| **Co-primary** | `researcher` — company enrichment before the call |
| **Supporting** | `receptionist` (callbacks), `librarian` |
| **Tabs** | `dash` · `leads` · `calls` · `calendar` · `teach` · `work` |
| **Hidden** | orders |
| **Scored on** | dials/day, connect rate, meetings booked, DNC hygiene |

The dashboard here is a **pipeline**, not a phone log — Leads is the
home tab, not Dash. The dialer's pacing controls are front and centre.

Compliance is the hard constraint, not a footnote: TCPA quiet hours,
DNC honoured instantly and permanently, consent basis required on every
lead before it can be dialed, no performance guarantees, no comment on
anyone's existing plan. Objection handling lives in
`instances/retirement-plan-resource-group/agents/calling.md` and was
compliance-reviewed by the client — do not edit it without them.

---

## Blueprint: `hospitality` — *the RFP gets answered first*

**Prospect:** Myrtle Beach hotel group (100-property upside) · **Plan:** Multi

| | |
|---|---|
| **Primary agent** | `rfp-responder` — reads inbound event RFPs, drafts a tailored reply |
| **Co-primary** | `signal-watcher` — finds groups publicly looking for a venue |
| **Supporting** | `researcher`, `receptionist`, `librarian` |
| **Tabs** | `dash` · `leads` · `calls` · `teach` · `work` |
| **Hidden** | calendar, orders |
| **Scored on** | RFP response time (target < 10 min), response rate, RFPs won |

Speed *is* the product. An event planner emails six hotels; whoever
answers first with real specifics wins. Nothing sends without approval —
Tier 1, batch-approve.

Multi-property: one instance, property as a dimension on every lead and
report, roll-up on Dash. Do not deploy one service per hotel.

---

## Blueprint: `local-service` — *the truck doesn't stop for the phone*

**Prospect:** car wash · also: HVAC, detailing, salons, auto shops
**Plan:** Solo → Business

| | |
|---|---|
| **Primary agent** | `receptionist` — books the slot, answers hours/price |
| **Supporting** | `librarian`, `calling` (win-back, dormant) |
| **Tabs** | `dash` · `calls` · `calendar` · `teach` · `work` |
| **Hidden** | leads, orders |
| **Scored on** | bookings, after-hours capture, repeat-customer win-backs |

The simplest build in the catalog — an afternoon. This is the volume
vertical and the one where onboarding must be fully self-serve before we
chase it.

---

## Blueprint: `hq` — *Sailz runs on Sailz*

**Instance:** `sailz-hq` · not sold, not billed

| | |
|---|---|
| **Primary agent** | `hq-chief-of-staff` |
| **Specialists** | growth · content · finance · success · research · reliability |
| **Tabs** | `dash` · `clients` · `pipeline` · `money` · `teach` · `work` |
| **Scored on** | founder-minutes/day (target <15), MRR per founder hour |

Two jobs, and the second is the important one:

1. **Run the company** — the six specialists from
   `docs/HQ-AUTONOMY-SPEC.md`.
2. **Be the test bench.** Every new agent is built and proven on HQ
   before it touches a paying client. HQ has the same engine, the same
   catalog, the same map — so "does this work?" is answered on our own
   money, on our own phone line, against our own data. A client instance
   is never the first place an agent runs.

If Sailz's own brain can't book Sailz's own discovery calls, we have no
business selling it. Dogfooding isn't a nice-to-have here — it's the
demo.

---

## Adding a new vertical

1. Add a section here first. If you can't name the primary agent in one
   sentence, you don't understand the buyer yet.
2. Decide the tab list by asking "what does the primary agent produce?"
3. Add `brain/blueprints/<vertical>.json`.
4. Only then write instance config. The blueprint sets the defaults;
   `instances/<id>/instance.json` overrides only where the client is
   genuinely different.
5. Prove it on `sailz-hq` before the client's service exists.

## Current assignments

| Instance | Vertical | Primary agent | Plan |
|---|---|---|---|
| `shine-dental` | dental | receptionist | Business |
| `the-burg` | restaurant | receptionist (orders) | Business |
| `retirement-plan-resource-group` | financial-services | calling + researcher | Solo |
| *(myrtle, TBD)* | hospitality | rfp-responder | Multi |
| *(car wash, TBD)* | local-service | receptionist | Solo |
| `sailz-hq` | hq | hq-chief-of-staff | — |
