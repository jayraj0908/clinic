# Prompt for Cursor / Claude Code — Restaurant Vertical (The Burg)

Run after prompt 4 (onboarding wizard) or before it if The Burg's demo is
urgent — this prompt is self-contained. Copy below the line.

---

You are working on **Sailz** (this repo). A second client is being
provisioned: The Burg, a pizza/burger shop — inbound AI order line. Their
instance already exists at `instances/the-burg/` (instance.json, profile
with menu-as-services + modifiers, an order-taker receptionist override).
Read first: `clients/the-burg.md`, `instances/the-burg/`,
`server/instance.js`, the Vapi webhook in `server/server.js`,
`server/notify.js`, `server/brain.js`.

## Mission

Make the engine support the restaurant vertical with ONE new concept —
orders — without breaking the dental instance in any way.

## Hard constraints

1. Shine Dental's deployment must be entirely unaffected: all new behavior
   is additive and keyed off instance vertical or tool presence. Run the
   full existing regression (dental) after every stage.
2. No payment handling of any kind (pay at pickup).
3. Same design system for any UI.
4. Small commits per stage + verification.

## Stage 1 — Orders in the store + Vapi tool

- `db.orders`: `{id, ts, customer:{name, phone}, items:[{name, qty,
  modifiers[], price}], notes, allergyFlag, total, pickupTime, status:
  "new"|"preparing"|"ready"|"picked_up"|"cancelled", vapiCallId}`.
- New Vapi tool-call handler `place_order` (same normalizeToolCall
  pattern): validates items against the instance profile's services list
  (fuzzy name match), computes total from listed prices where possible,
  writes the order, logs activity, RETURNS a short spoken confirmation
  string ("Order in — $24.48, ready in about 20 minutes").
- Duplicate guard: one order per vapiCallId unless explicitly additive.

## Stage 2 — Kitchen ticket + customer confirmation

- On order placed: kitchen ticket via notify.js — SMS and/or email to
  KITCHEN_SMS / KITCHEN_EMAIL env destinations, formatted monospace:
  items, modifiers, ALLERGY line prominent if flagged, pickup time,
  customer first name + masked phone.
- Customer confirmation SMS from messages.json template (create
  `instances/the-burg/messages.json` with restaurant wording).
- All sends logged; both destinations optional (no-op with warning).

## Stage 3 — Orders in the dashboard

- Orders tab (visible only when the instance has orders or vertical ===
  "restaurant"): live list, status chips, one-tap status advance
  (new → preparing → ready → picked_up), order drawer with full ticket.
- Attention inbox: orders in "new" older than 5 min ("kitchen hasn't
  started"). Bell counts them.
- Brain map: order events feed the receptionist node's activity like
  calls do today.

## Stage 4 — Demo mode (for the sales pitch)

- `DEMO_MODE=1` env: banner "DEMO" in the dashboard, and a
  `POST /api/demo/reset` (owner) that clears orders/calls/leads so the
  pitch always starts clean. Nothing else behaves differently — the demo
  IS the real product.

## Stage 5 — Verification

```bash
# INSTANCE=the-burg boot: graph shows the order-taker agent set, profile
#   menu loads, no dental remnants in the receptionist prompt
# fake Vapi place_order tool-call → order row created, total computed,
#   kitchen SMS logged (or warned if unconfigured), confirmation SMS
#   logged, spoken confirmation string returned
# order with unknown item → graceful "not on the menu" result, no row
# duplicate place_order same vapiCallId → no duplicate order
# allergy flag → ALLERGY line present in the ticket text
# dashboard Orders tab renders; status advance works; attention fires for
#   stale new orders
# INSTANCE=shine-dental (default) full regression: everything passes,
#   no Orders tab appears
node --check all changed files
```

## Out of scope

Shift4/SkyTab POS write (partner application pending — keep the order
model clean so it maps to their API later), delivery dispatch, phone
payments, multi-language.
