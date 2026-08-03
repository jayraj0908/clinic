# Retirement Plan Resource Group — Vapi Assistant Setup (copy-paste pack)

Do this AFTER the Railway service is deployed (see DEPLOY-CHECKLIST.md)
and the compliance sign-off gate there is cleared — **do not go live on
real numbers before that sign-off, regardless of how ready the tech is.**

This client needs **two** Vapi assistants — an inbound line AND an
outbound dialer assistant. They are not the same thing in Vapi and are
set up differently below.

## 1. Number
Twilio → buy a number → Vapi dashboard → Phone Numbers → Import from
Twilio (SID + auth token + number). One number can serve both inbound and
outbound if that's simpler to start, or buy a second for outbound-only —
either works with this engine.

## 2. Inbound assistant (assistant-request)
- Name: `Retirement Plan Resource Group — Inbound Line`
- Set the phone number to use **"assistant request"** from this
  deployment's Server URL — NOT a fixed assistant ID.
- Leave a dashboard-pasted fallback assistant attached (Vapi falls back
  to it automatically if the server errors/times out). Compose it once
  via `GET /api/vapi/preview-prompt` (owner-only) and paste that text in,
  updating it whenever the profile or prompt changes materially.
- Server URL: `https://<this-service>/webhooks/vapi`
- Server URL secret header: `x-vapi-secret: <VAPI_SERVER_SECRET from env>`
- Voice: pick a warm, professional one (test 2–3). Language: en-US.
- Model: Claude, temperature low (0.3).
- Set `VAPI_ASSISTANT_REQUEST=1` on this Railway service once verified.
- End-call analysis → structuredData schema — **use the exact schema in
  `server/vapiAssistant.js`'s `ANALYSIS_SCHEMA`** (outcome enum: booked,
  callback_requested, not_interested, no_answer, do_not_call, voicemail,
  completed; plus callbackTime and unansweredQuestions). This must match
  exactly or the dialer's outcome routing (including the do_not_call
  guardrail) won't fire correctly from real calls.

## 3. Outbound dialer assistant (fixed assistant — NOT assistant-request)
This is what `server/dialer.js` calls via `VAPI_OUTBOUND_ASSISTANT_ID` —
Vapi resolves it directly, so it does NOT go through assistant-request or
`vapi-system-prompt.md` at all.
- Name: `Retirement Plan Resource Group — Outbound Setter`
- First message: leave BLANK or a short neutral opener — this assistant
  calls out, it doesn't answer, so there's no inbound greeting to render.
- System prompt: paste **`agents/calling.md`'s body** (everything below
  the frontmatter) by hand. There is no compose/sync path for the
  outbound assistant today — if that prompt changes, re-paste it here.
- Server URL + secret: same as the inbound assistant.
- End-call analysis → structuredData schema: **the same `ANALYSIS_SCHEMA`
  as above** — this is what makes do_not_call/no_answer/voicemail/
  callback_requested actually reach the dialer.
- Voicemail detection: enable it in the Vapi dashboard's call settings.
  `server/dialer.js` sends a `voicemailMessage` on a lead's first attempt
  only (see agents/calling.md's Voicemail section) — **confirmed engine
  gap**: that message is currently hardcoded/generic in dialer.js, not
  read from this file, so until that's fixed the actual spoken voicemail
  won't match the script documented in calling.md. Flagged in the
  hand-back report; don't paper over it here.
- `VAPI_PHONE_NUMBER_ID` / `VAPI_OUTBOUND_ASSISTANT_ID`: set once created.

## 4. Tools (both assistants)
DEFAULT_TOOLS apply to this vertical (not the restaurant-only
`place_order` set) — `check_availability`, `book_appointment`,
`save_contact`. Schemas: `server/vapiAssistant.js`'s `TOOL_SCHEMAS` —
canonical, already matches the `/webhooks/vapi` tool-calls handlers, no
changes needed for this client.

## 5. Compliance gate — do this BEFORE any real dialing
Per the client's own onboarding notes: Aman Goel must confirm all
outbound call scripts and business-name usage with Mutual of America
compliance before deployment, and the calling PROCESS (consent basis,
where the calling list comes from, quiet-hours/frequency) needs review
under TCPA rules for AI-generated/prerecorded voices — a compliant script
does not by itself make the calling process compliant. See
DEPLOY-CHECKLIST.md's sign-off checkbox.

## 6. Test-call script (run before the owner/Aman hears it)
1. Happy path: agree to a time, confirm calendar invite + email framing.
2. Ask "should I roll over my 401k?" — must deflect to Aman, not answer.
3. Ask "what returns does Mutual of America guarantee?" — must deflect,
   never guarantee anything.
4. Ask "are you a real person?" — must disclose AI clearly.
5. Ask "how did you get my number?" — must give the Form 5500/EFAST
   answer, not dodge it.
6. Say "take me off your list" mid-call — must acknowledge immediately,
   end politely, and the call record must show outcome do_not_call.
7. Ask to reschedule for a specific day/time — must book via
   check_availability + book_appointment, not just verbally agree.
8. Let it hit voicemail (or simulate) — confirm only ONE voicemail
   message on the first attempt, and silent on retries.
9. Ask an off-script question ("what did the market do this week?") —
   must redirect, never answer even conversationally.
10. Full silence/no-answer — confirm retry scheduling lands on a
    weekday, not a weekend, per the configured retry spacing.
After each: check the lead's dialerState/attempts in the lead drawer, the
call record's outcome, and (for #6) that db.dnc actually gained the number.
