# Prompt for Cursor / Claude Code — Vapi Assistant-Request (one source of truth)

Run AFTER catalog prompt 9 fully lands (this touches the same webhook
file). Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway with real phone
traffic. Read first: the Vapi webhook in `server/server.js`,
`server/vapiSync.js`, `server/instance.js`, `server/brain.js`,
`instances/the-burg/vapi-system-prompt.md`,
`instances/the-burg/clinic-profile.json`.

## Mission

Kill the copy-paste between our config and the Vapi dashboard. Use
Vapi's **assistant-request** pattern: when a call comes in, Vapi POSTs
`{message:{type:"assistant-request", call:{...}}}` to our Server URL and
we respond with the full assistant config — prompt composed fresh from
the instance's profile JSON + approved memory at that moment. The repo
becomes the single source of truth for what the phone line knows.

## Hard constraints

1. **Feature-flagged per deployment**: env `VAPI_ASSISTANT_REQUEST=1`
   enables it; absent/0 → the handler ignores assistant-request messages
   (Vapi then uses the dashboard-attached assistant exactly as today).
   Shine and The Burg both stay on current behavior until the flag is
   flipped per service.
2. The dashboard-pasted assistant stays attached in Vapi as the FALLBACK
   (Vapi falls back to it if our server errors/times out). Document this
   in the response to the operator; never instruct removing it.
3. Response must be fast: compose from in-memory/parsed state, no LLM
   calls, no disk reads per request (cache with invalidation on memory
   approval). Target < 300ms.
4. Verify the existing x-vapi-secret on assistant-request like every
   other Vapi message. Additive changes only; small commits; verify.

## Stage 1 — Prompt composer (single source of truth)

- `server/vapiAssistant.js`: `composeSystemPrompt()` builds the full
  system prompt from:
  (a) behavior sections of `instances/<id>/vapi-system-prompt.md` — but
  menu/hours/address/policy content must come from clinic-profile.json,
  not the md. Convention: the md may contain `<!-- AUTO:MENU -->`,
  `<!-- AUTO:HOURS -->`, `<!-- AUTO:POLICIES -->` markers that get
  replaced with sections rendered from the profile; if markers are
  absent, append rendered sections at the end under clear headings.
  Update The Burg's md to use the markers (delete its hardcoded menu).
  (b) approved faq_gap/policy_correction memory facts (reuse
  buildReceptionistPrompt logic from vapiSync.js — refactor to share,
  don't duplicate).
- `GET /api/vapi/preview-prompt` (auth, owner): returns the composed
  prompt so the operator can eyeball exactly what a caller would get.

## Stage 2 — The assistant-request handler

- In the Vapi webhook: `type === "assistant-request"` and flag on →
  respond `{assistant:{...}}` with: composed system prompt; firstMessage,
  voice, and model from a new optional `vapi` block in instance.json
  (defaults documented in instances/_template); the tool set by
  vertical (restaurant → place_order; clinic → check_availability,
  book_appointment, save_contact) with schemas matching the existing
  server handlers exactly; the end-call analysis schema (outcome +
  unansweredQuestions); server url + secret preserved.
- Flag off → fall through to existing behavior (return {} or ignore per
  Vapi spec so fallback assistant is used).
- Cache the composed config; invalidate on memory approval and on boot.

## Stage 3 — Verification

```bash
# flag ON + fixture assistant-request POST →
#   response.assistant.model/messages contains Butter Chicken Pizza
#   ($19.00) from the profile JSON (NOT from the md — remove it there and
#   confirm it still appears via AUTO:MENU)
#   tools = restaurant set for the-burg; clinic set for shine-dental
#   analysis schema present; wrong secret → 403; latency logged < 300ms
# approve a memory fact → next assistant-request includes it (cache
#   invalidated)
# flag OFF → assistant-request gets pass-through response; all existing
#   tool-call/end-of-call behavior byte-identical (full regression)
# /api/vapi/preview-prompt owner-only; staff 403
node --check all changed files
```

## Operator steps (document in the file header of vapiAssistant.js)

After deploy + verification: in Vapi dashboard, set the PHONE NUMBER to
use "assistant request" from our Server URL (keep the static assistant
attached as fallback), set VAPI_ASSISTANT_REQUEST=1 on the Railway
service, make a live test call, check /api/vapi/preview-prompt matches
what the call knew. Rollback = flip the flag off.

## Out of scope

Removing vapiSync.js (the weekly push stays as belt-and-suspenders for
fallback-assistant freshness), per-call dynamic voices, multilingual.
