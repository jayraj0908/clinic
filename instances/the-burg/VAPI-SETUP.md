# The Burg — Vapi Assistant Setup (copy-paste pack)

Do this AFTER prompt 8 is deployed to the-burg Railway service.
**The tool schema below is canonical — the server's `place_order` handler
must accept exactly this shape** (Cursor: conform to this when
implementing prompt 8).

## 1. Number
Twilio → buy local Richmond number → Vapi dashboard → Phone Numbers →
Import from Twilio (SID + auth token + number).

## 2. Assistant — basic settings
- Name: `The Burg — Order Line`
- First message: "Thanks for calling The Burg! What can I get started for you?"
- Voice: pick a warm, quick one (test 2–3; restaurants suit faster speech
  ~1.05x). Language: en-US.
- Model: Claude (or default) — temperature low (0.3).
- Server URL: `https://<the-burg-railway-url>/webhooks/vapi`
- Server URL secret header: `x-vapi-secret: <VAPI_SERVER_SECRET from env>`
- End-call analysis → structuredData schema: include
  `outcome` (ordered | no_order | question_only | hangup) and
  `unansweredQuestions` (array of strings) — feeds the librarian.

## 3. System prompt
Compose = `instances/the-burg/agents/receptionist.md` body + the menu
rendered from `clinic-profile.json` (after the real menu is in). Once
prompt 3's dry-run compose works for this instance, copy it from the sync
log. Until then, paste the agent body + a MENU section by hand.

## 4. Tool: place_order  (canonical schema)
```json
{
  "type": "function",
  "function": {
    "name": "place_order",
    "description": "Place the confirmed pickup order. Call ONLY after reading the full order, total, and pickup time back to the customer and they confirm.",
    "parameters": {
      "type": "object",
      "properties": {
        "customer_name": { "type": "string", "description": "First name for the order" },
        "phone": { "type": "string", "description": "Callback/SMS number, digits only" },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": { "type": "string", "description": "Menu item name, as close to the menu wording as possible" },
              "qty": { "type": "integer", "minimum": 1 },
              "modifiers": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["name", "qty"]
          }
        },
        "notes": { "type": "string", "description": "Anything else the kitchen needs" },
        "allergy": { "type": "string", "description": "Allergy the customer mentioned, verbatim; empty if none" }
      },
      "required": ["customer_name", "phone", "items"]
    }
  }
}
```
The server replies with a `result` string the assistant speaks verbatim
(e.g. "Order in — $24.48, ready in about 20 minutes.").

## 5. Prompt rules that matter on live calls (already in the agent file —
verify they survive into the final prompt)
- Confirm each item + modifiers as you go; full read-back before place_order
- Never invent items/prices; unknown item → offer closest menu match
- No payment over the phone; allergies read back + flagged
- If place_order returns an error, apologize and take name+phone for a
  human callback — never pretend the order went through

## 6. Test-call script (run all 20 before the owner hears it)
1. Simple: one burger, no mods.  2. Mods: no onion, extra bacon.
3. Half-and-half pizza.  4. Item not on menu.  5. Change mind mid-order.
6. Allergy (peanut).  7. Ask hours/address only, no order.  8. Mumble the
phone number.  9. Big order (6 items).  10. Ask for delivery (should
explain pickup-only)... plus 10 free-form. After each: check order row,
kitchen ticket text, confirmation SMS, transcript.
