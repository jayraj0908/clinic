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
| 12 | Sailz HQ instance (admin gate) | ✅ done — stage 1 hotfix (SAILZ_ADMIN flag), stage 2 (instances/sailz-hq/), stage 3 (heartbeat protocol + db.clients registry), stage 4 (admin.html client board + onboarding tab), stage 5 verified. TODO (later HQ stage, not started): client nodes on HQ's own brain map — the map itself is untouched/as-is for now. |
| 11 | Mobile-first pass | ✅ done (audit + bottom-tab nav, map on touch, work surfaces, installable PWA, verified — see MOBILE-AUDIT.md) |
| 13 | Vapi assistant-request (server/vapiAssistant.js) | ✅ done, flag off everywhere — see operator steps in vapiAssistant.js's file header before flipping VAPI_ASSISTANT_REQUEST=1 on either service |
| 10 | Lead Engine v1 | ✅ done — RFP inbox agent (rfp-responder), speed-to-lead auto-queue (quiet hours + DNC), signal watcher (proposed leads, human-gated), mobile Leads pipeline tab. Both new agents dormant by default everywhere (fixed a real bug in catalog.js's fallback along the way — see commit `01f381a`). Myrtle hotels pitch unblocked. |
| 5 | Case threads | 🗂 parked (docs/queue/) |

Executed prompts: `docs/archive/` · Strategy docs: `docs/` ·
Per-client briefs + demo runbook + pilot agreement: `clients/` ·
Instance config: `instances/`

## Clients

| Client | Stage | Next action |
|---|---|---|
| Shine Dental | LIVE | keep librarian approvals flowing; case-study stats |
| The Burg | Vapi wired, menu items in | fill $TBC prices → 5 test calls → demo + pilot signing |
| Car wash | discovery | book discovery call; instance is ~an afternoon |
| Myrtle hotels | proposal | Lead Engine (prompt 10) shipped — RFP pitch unblocked, ready to send |

## Founder checklist (non-code)

- [ ] Buy domain (sailz.com TAKEN; sailz.io likely free — confirm at
      registrar) → wire client subdomains in Railway
- [ ] Immigration attorney consult: "12-mo OPT, PM degree — report Sailz
      as degree-related self-employment?" — GATES ALL REVENUE
- [ ] Pilot agreements signed (Burg → car wash), zero billing until cleared
- [ ] A2P campaign resubmit (after next push; CTA text in chat history /
      pages already updated)
- [ ] LLC after attorney green light (VA SCC, $100, DIY)
- [ ] Push cadence: batch → review → push → verify live → next batch
