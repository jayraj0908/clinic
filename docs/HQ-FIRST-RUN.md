# HQ first run — what's actually real, as of 2026-08-05

This is the honest record the build spec asked for: what got proven end
to end on real infrastructure, what's built but unverified because a
credential doesn't exist yet, and what the agent actually said when
tested for real. Not a status board — a record of a real run.

## What's verified end to end, right now

**The site chat (Stage 4).** Live-tested through the real browser UI
against `sailz-hq`, not just curl. A visitor scrolls to the "Sailz
intake" widget, the widget calls `POST /api/site/chat`, and gets a real
Claude Haiku reply — not the scripted fallback. Full transcript of one
verification run:

> **Sailz:** Hey! I'm Sailz's AI chat. We build phone agents for small
> businesses, they answer calls, take orders, and follow up with leads
> so nothing gets missed. What's your name?
>
> **Visitor:** Hi, I'm Sam, I run a small salon and we miss calls all
> the time
>
> **Sailz:** That's a really common problem, salons get slammed and
> calls just go to voicemail. How many calls are you getting on an
> average day?

A second, longer run (dental office, no-shows) ran 3 turns, correctly
quoted the real Solo/Business/Multi pricing from
`instances/sailz-hq/clinic-profile.json` (not invented numbers), called
`end_conversation` with `outcome:"qualified"`, and produced a real
`db.leads` entry with `source:"website-chat"`, the full transcript, and
a one-sentence summary. Cost: $0.0119–$0.0149 for a 3-turn conversation
(measured, logged per-conversation in `lead.chat.costUsd`) — under the
2-cent target for a typical conversation; a 6-turn one measured $0.029,
over target, mostly from resending growing conversation history as
input tokens each turn. Not optimized further this pass.

**Bugs found and fixed during this verification, not before it:**
1. A response containing both a text reply and a tool call
   (`stop_reason:"tool_use"`) was having its text silently discarded —
   the loop only kept the *last* round's content. Every reply looked
   like "Could you say a bit more about that?" until this was caught by
   actually running a conversation, not by reading the code.
2. The model calling `save_lead_info` with a contact value that didn't
   parse as a phone or email (e.g. it held a value that wasn't the
   actual number) silently discarded a caller's real phone number even
   though it was in the transcript. Fixed with a transcript-regex
   fallback that only triggers when the tool-recorded contact doesn't
   actually look like a phone or email.
3. The phone-detection regex required 7 *consecutive* digits
   (`/\d{7,}/`), which never matches a normally-formatted US number
   like "804-555-7788" (digits broken up by hyphens). This silently
   dropped every phone number with separators until caught by checking
   the actual saved lead record, not just the API response.
4. Haiku's replies used em dashes ("That's a really common problem —
   salons get slammed") violating the project's own copy rule. Added an
   explicit no-em-dash instruction to the chat's system prompt.

All four are fixed and re-verified. The lesson: none of these would
have been caught by code review or a single happy-path curl call — they
only surfaced from running a real multi-turn conversation and checking
the actual database record afterward, not just the HTTP response.

**The map extraction (Stage 3, dashboard half).** `public/js/brain-map.js`
carries the full rendering/camera/morph engine out of `public/index.html`.
Verified locally against a real Shine Dental boot: ring view, hub focus
(morph + camera dive), leaf click (focus + sidebar open + camera shift
for the panel + halo ring), Escape (close panel, then exit focus), and
theme toggle. One real regression caught and fixed during this pass: the
theme toggle referenced `PAL`, a constant that moved into the new module
and was no longer in scope, which would have crashed the toggle click on
every live dashboard the moment this shipped. Console was clean after
the fix.

**Client isolation.** Verified against a fresh Shine Dental boot with no
`SAILZ_ADMIN`: `/api/site/chat`, `/api/site/lead`, `/api/hq/research/*`,
`/api/hq/clients`, and `/onboarding-review.html` all 404. `dash.testCallEnabled`
and `dash.enrichmentEnabled` both read `false` — zero surface exposed to
a client that isn't HQ.

**The dialer's `notDialable` hard gate.** Unit-verified directly against
`dialer.js`: a lead with `notDialable:true` is refused even when it
carries a `consentBasis` — no bypass. A lead with `notDialable:false`
passes this specific check and fails later on its own merits (verified
against a real, correctly-rejected fake Vapi key — the guard doesn't
short-circuit the rest of the pipeline).

## What's built but not verified live, and why

Everything below is real code, syntax-checked, and unit-tested with
mocked providers where a live key doesn't exist. None of it has run
against real phone infrastructure, because `sailz-hq` doesn't have that
infrastructure provisioned yet — this isn't a code gap, it's a
credentials gap that only Jay can close (I can't sign up for
Vapi/Twilio/Perplexity accounts on his behalf).

| Missing | Blocks |
|---|---|
| Vapi assistant + phone number for `sailz-hq` | Real inbound calls (someone calls Sailz's own line and the receptionist answers), real outbound calls (the calling agent dials a sourced business) |
| Google Calendar connection for `sailz-hq` | A discovery call actually landing on a real calendar |
| `PERPLEXITY_API_KEY` | `server/research.js`'s `query()` and `sourceLeads()` — currently degrade cleanly to `{unavailable:true, reason:"no_perplexity_key"}`, verified with a mocked Perplexity response instead (real cited answers, real citation-required rejection, real 30-day cache hit, real ICP-to-lead parsing with the mobile-number gate correctly marking every result `notDialable` since no lookup provider was configured either) |
| A phone-type lookup provider (Twilio Lookup: `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`) | Any HQ-sourced lead ever being dialable. Without it, `checkPhoneType()` fails closed on every number — by design, not a bug. A wrongly-called mobile number is a TCPA problem, not just a bad lead, so "we don't have the provider" means "nothing is dialable," never "assume it's fine." |

`HQ_LIVE`, `RESEARCH_ENABLED`, and `SITE_CHAT` are the flags gating this
work; all three are off by default and require `SAILZ_ADMIN=1` (or
`HQ_LIVE=1` specifically, for `SITE_CHAT`). Turning them on with no
downstream credentials configured is safe — every code path degrades to
an honest "unavailable" or a 404, never a guess.

## What Stage 5 actually asked for, and the honest status of each part

1. **Sourcing 25 real businesses, one vertical, Jay approves the batch.**
   Not run — needs `PERPLEXITY_API_KEY`. The pipeline itself
   (`sourceLeads()` → `status:"proposed"` → existing
   `/api/leads/:id/approve-proposed` → `consentBasis` written from the
   sourcing record only on approval) is built and passed a mocked test
   with 2 candidate businesses, one with a phone number (correctly
   marked `notDialable` — no lookup provider) and one without.
2. **Enrichment: a cited summary for each one.** Same blocker — the
   summarization path is the same `query()` function verified above,
   just not run against 25 real sourced leads yet.
3. **Outbound: the dialer works the approved list under real pacing,
   quiet hours, DNC.** Not run — no Vapi for HQ. The one new guardrail
   this stage adds (`notDialable`) is unit-verified in isolation; the
   pre-existing pacing/DNC/consent/hours guards are unchanged and were
   already covered by this session's earlier RPRG work.
4. **Inbound: a stranger calls Sailz's number, receptionist books a
   slot.** Not run — no Vapi number, no calendar connection for HQ.
5. **Site: someone talks to chat, lead appears and gets enriched
   automatically.** Half-verified. The chat-to-lead half is fully real
   (see above). The "gets enriched without anyone touching it" half
   isn't wired yet — a website-chat lead lands with a summary from the
   conversation itself, but nothing currently calls
   `research.sourceLeads`-style enrichment on it automatically. That's
   a real gap in this pass, not a credentials gap: worth a follow-up
   route (`enrichLead` already exists generically in `researcher.js`
   and could run on every new `website-chat` lead once a search
   provider or Perplexity key exists).

## Connect rate, booking rate, cost per booked meeting

Not measurable yet — these require real phone volume (Stage 5 items 3
and 4), which need the Vapi/Twilio/GCal credentials above. The one real
cost number available is the site chat's: $0.012–$0.029 per completed
conversation, logged per-lead in `lead.chat.costUsd`.

## Where the agent sounded wrong

Nothing sounded wrong in tone or claims during the two verified
conversations — no invented pricing, no promised outcomes, correct
plan recommendations for the stated call volume, and a clean
disclosure-on-request path (not tested this pass, since neither test
conversation asked directly, but the system prompt carries the
instruction and it's the same mechanism already proven honest on the
pricing question). The real issues found were structural (tool-use text
loss, contact-field parsing, phone-format regex, em dashes), not
conversational — listed and fixed above.

## Next steps, in order

1. Jay provisions a Vapi assistant + phone number, and a Google Calendar
   connection, for `sailz-hq` — same process already used for
   RPRG/Shine/The Burg.
2. Jay gets a `PERPLEXITY_API_KEY` and sets it on `sailz-hq`.
3. Jay decides on a phone-type lookup provider (Twilio Lookup is the one
   wired) and sets those credentials, or the mobile-number gate stays
   permanently closed by design.
4. With those three in place: run a real 25-business sourcing pass in
   one vertical, approve the batch, let the dialer work it, and update
   this document with real connect/booking/cost numbers instead of "not
   measurable yet."
5. Wire automatic enrichment onto new `website-chat` leads (the one real
   code gap from this pass, not credential-blocked).
6. Reconcile `public/js/brain-map.js` (dashboard) and `site/map.js`
   (public site) into one shared module — they're currently two
   independent implementations of the same constellation renderer,
   which the original spec asked to avoid. Not done this pass; flagged
   to Jay as known follow-up debt, not silently left undocumented.
