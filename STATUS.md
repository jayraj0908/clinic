# SAILZ — Status Board (single source of truth)

*Update this file whenever a prompt finishes or a client moves stage.*

## Product focus
**Sailz Front Desk** — answer every call, book the thing (appointment /
order / wash), confirm it. The universal pain, sold to every vertical.
**Sailz Leads** — add-on: RFP response, lead capture, instant callback.

## Build state

| # | Prompt | Status |
|---|---|---|
| 1 | Engine/instance refactor | ✅ live |
| 2 | Confirmations · attention bell · chat | ✅ live |
| 3 | Memory/librarian + Vapi sync (dry-run) | ✅ live |
| 4 | Onboarding wizard + auth polish | ✅ done |
| 6 | Calls tab + calendar | ✅ done |
| 7 | Security & HIPAA hardening | ✅ done |
| 8 | Restaurant vertical (orders) + agent allowlist | ✅ done |
| 9 | Agent catalog / plug-and-play store | 🔨 stages 1–3 done, 4–6 in flight |
| 12 | Sailz HQ instance (admin gate) | ✅ done — stage 1 hotfix (SAILZ_ADMIN flag), stage 2 (instances/sailz-hq/), stage 3 (heartbeat protocol + db.clients registry), stage 4 (admin.html client board + onboarding tab), stage 5 verified. **Deployed live 7/31**: own Railway service + volume, both Shine and The Burg registered on the client board and polling healthy. TODO (later HQ stage, not started): client nodes on HQ's own brain map — the map itself is untouched/as-is for now. |
| 11 | Mobile-first pass | ✅ done (audit + bottom-tab nav, map on touch, work surfaces, installable PWA, verified — see MOBILE-AUDIT.md) |
| 13 | Vapi assistant-request (server/vapiAssistant.js) | ✅ done, flag off everywhere — see operator steps in vapiAssistant.js's file header before flipping VAPI_ASSISTANT_REQUEST=1 on either service |
| 10 | Lead Engine v1 | ✅ done — RFP inbox agent (rfp-responder), speed-to-lead auto-queue (quiet hours + DNC), signal watcher (proposed leads, human-gated), mobile Leads pipeline tab. Both new agents dormant by default everywhere (fixed a real bug in catalog.js's fallback along the way — see commit `01f381a`). Myrtle hotels pitch unblocked. |
| 14 | Onboarding v2 — Teach Your Brain | ✅ done — richer file types (images via Claude vision, audio w/ transcription), voice recording in the wizard, "what do you want" goals step, and a forever-on Teach tab on the client dashboard feeding the same memory/librarian pipeline + a new live-editable profile-overlay (proposed diffs, approved edits go live with no redeploy). |
| 15 | Outbound Lead Engine v1 | ✅ done — bulk CSV lead import (consent attestation required, server-enforced), a new paced dialer (server/dialer.js: concurrency/hourly caps, per-lead quiet hours, attempts cap, weekend-skipping retry, one-voicemail-then-silent) fully separate from the existing setter() cron, batch scoreboard, and owner-editable pacing on the Calling Agent panel. |
| 16 | First outbound-dialer client build (Retirement Plan Resource Group) | ✅ instance built, pending Railway deploy + Mutual of America compliance sign-off. Found + fixed two real engine bugs along the way (not client-specific hacks): `scripts/pull-onboarding.mjs` was reading the wrong draft field names (every past pull silently under-wrote instance files); Vapi's `ANALYSIS_SCHEMA` outcome enum didn't include do_not_call/no_answer/voicemail/callback_requested, meaning the DNC opt-out guardrail could never actually fire from a real call. Both fixed in shared engine code. Open engine gap (documented, not hacked around): dialer.js's first-attempt voicemail script is hardcoded/generic, not yet per-instance. |
| 5 | Case threads | 🗂 parked (docs/queue/) |

Executed prompts: `docs/archive/` · Strategy docs: `docs/` ·
Per-client briefs + demo runbook + pilot agreement: `clients/` ·
Instance config: `instances/`

## Clients

| Client | Stage | Next action |
|---|---|---|
| Shine Dental | LIVE | keep librarian approvals flowing; case-study stats |
| The Burg | Vapi wired, menu items in | fill $TBC prices → 5 test calls → demo + pilot signing |
| Retirement Plan Resource Group | Instance built (prompt 16), not deployed | Mutual of America compliance + TCPA sign-off FIRST, then Railway service per instances/retirement-plan-resource-group/DEPLOY-CHECKLIST.md |
| Car wash | discovery | book discovery call; instance is ~an afternoon |
| Myrtle hotels | proposal | Lead Engine (prompt 10) shipped — RFP pitch unblocked, ready to send |

## Founder checklist (non-code)

- [x] SECURITY DEBT closed 7/31: VAPI_SERVER_SECRET set on both Shine
      Vapi assistants (inbound + outbound, header confirmed via
      isServerUrlSecretSet) and on Shine's Railway env. Verified live:
      /webhooks/vapi 403s without the header, 200 with it, boot warning
      gone. No other assistant fields touched (diffed before/after).
- [x] Burg mismatch closed 7/31: turned out to be a legacy custom
      `server.headers['x-vapi-secret']` config (not Vapi's native
      `secret` field, so isServerUrlSecretSet read false even though a
      header WAS being sent) with a value that didn't match Railway's.
      Migrated to the same native field Shine uses, fresh secret on
      both sides, legacy header field removed. Verified live: 403
      without the header, 200 with it. Incident: GETting the assistant
      to inspect this printed that legacy header value into a session
      transcript before its shape was known — immediately rotated away
      (this fix), so that value is void everywhere now.
- [x] Fixed 7/31: availability was only ever offering the earliest
      morning slots (old code broke out of the scan loop the moment it
      found MAX_SLOTS free ones) — now spreads evenly across the whole
      open day. Verified live against Shine's real calendar.
- [x] Sailz HQ stood up on Railway 7/31 — own service (sailz-hq) +
      volume, admin console live, Shine + The Burg both registered on
      the client board and polling healthy. Jay: wire hq.sailz.org
      (Cloudflare integration, SSL already Full) — using the Railway-
      generated URL until then. Login is in hq-credentials.txt
      (gitignored, local only) — first login forces a password change.
- [x] Domain bought (sailz.org) + shine/theburg subdomains wired
- [ ] Immigration attorney consult: "12-mo OPT, PM degree — report Sailz
      as degree-related self-employment?" — GATES ALL REVENUE
- [ ] Pilot agreements signed (Burg → car wash), zero billing until cleared
- [ ] A2P campaign resubmit (after next push; CTA text in chat history /
      pages already updated)
- [ ] LLC after attorney green light (VA SCC, $100, DIY)
- [ ] Push cadence: batch → review → push → verify live → next batch
