# The Burg — Pizza & Burgers, Richmond VA

## Problem (their words)
Can't afford a dedicated front-desk person. Want an AI receptionist that
answers every inbound call and places orders into their Shift4 (SkyTab) POS.

## Scope v1 — Inbound order line
- AI receptionist on their EXISTING number (via forwarding — see below).
- Knows the full menu (items, sizes, modifiers, prices, prep times).
- Takes the order conversationally, confirms total + pickup time.
- Order delivery to kitchen, phase 1: structured SMS/email ticket to a
  kitchen phone/tablet + logged in their Sailz dashboard. (POS write comes
  in phase 2 — see Honest limits.)
- Confirmation SMS to customer with order summary + pickup time.
- No payment over the phone v1 — pay at pickup (avoids PCI scope entirely).

## Phone setup — KEEP their number, no website changes
1. Buy one new Twilio number, import to Vapi, attach order-taking assistant.
2. Owner sets call forwarding from their existing business line to the new
   number (unconditional during rush/after-hours, or all-day).
3. Nothing changes publicly: same number on the website, Google, menus.
4. Reversible in 30 seconds (owner disables forwarding). Later, if they
   love it: port the number properly (1–4 weeks, do only once trust exists).

## Honest limits (review with owner before signing)
- **Shift4/SkyTab POS write-integration requires their partner/ISV program**
  — we apply, but approval timelines are theirs, not ours. Phase 1 ships
  without it (kitchen ticket flow) and works day one; phase 2 wires the POS
  when access is granted. Alternative if rejected: SkyTab's own online-
  ordering can ingest from an ordering page we host.
- Complex modifier chains ("half pepperoni, half veggie, light cheese,
  extra crispy") are the hard part of restaurant AI — we launch with the
  real menu modeled, but week 1 WILL surface fumbles; the librarian loop is
  how they get fixed. Set that expectation explicitly.
- Rush-hour call bursts: Vapi handles concurrent calls (this is actually
  the killer feature vs. one human — no busy signal ever).

## Provisioning checklist
- [ ] instances/the-burg/ (instance.json, profile: menu JSON, hours,
      messages.json — restaurant wording)
- [ ] Agent set: order-taker (receptionist variant), librarian. No dental
      agents — brain/ engine agents overridden per instance.
- [ ] New Railway service `the-burg` from same repo, own env, own volume
- [ ] Twilio number + Vapi assistant + forwarding instructions to owner
- [ ] Kitchen ticket destination (their choice: SMS number / email / both)
- [ ] Menu ingestion via onboarding wizard brain-dump (their POS menu
      export or photos of the menu)
- [ ] Owner + staff logins; test orders end-to-end; A2P for the SMS line

## Pricing note
Restaurant tolerates less monthly than dental (lower ticket) but volume is
high: propose setup $1,000–1,500 + $297–497/mo. One saved missed-order
dinner rush pays the month.

## Later
POS write via Shift4 partner API · phone payments (PCI) · delivery platform
sync · upsell prompts ("make it a combo?") · Spanish-language line.
