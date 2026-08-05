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
| 16 | First outbound-dialer client build (Retirement Plan Resource Group) | ✅ instance built and deployed to Railway (`rprg` service). Found + fixed two real engine bugs along the way (not client-specific hacks): `scripts/pull-onboarding.mjs` was reading the wrong draft field names (every past pull silently under-wrote instance files); Vapi's `ANALYSIS_SCHEMA` outcome enum didn't include do_not_call/no_answer/voicemail/callback_requested, meaning the DNC opt-out guardrail could never actually fire from a real call. Both fixed in shared engine code. A THIRD real engine bug found deploying this client: `server/instance.js`'s profile-edit replay called `store.load()` at module-load time, unconditionally — on a truly fresh volume this created an empty `db.json` before `server.js`'s own "seed if missing" check ever ran, permanently skipping the real seed (silently broke owner login on first deploy of any brand-new service). Fixed with an `fs.existsSync` guard before the `load()` call. Open engine gap (documented, not hacked around): dialer.js's first-attempt voicemail script is hardcoded/generic, not yet per-instance; the app has no lead-deletion API route at all (found while cleaning up a verification fixture on The Burg). **Still pending before any client demo:** `rprg.sailz.org` DNS/CNAME, Jay's own Server URL wiring on the Vapi assistant, Mutual of America compliance + TCPA sign-off, then a supervised QA session (1 real call + the three "should I roll over?" probes + a dialer test on Jay's own number). |
| 18 | HQ Autonomous Operations (Polsia pattern) | 📋 queued — spec in `docs/HQ-AUTONOMY-SPEC.md`, prompt in `docs/queue/SAILZ-CURSOR-PROMPT-18.md`. Chief of Staff → task system → 6 specialists (growth, content, finance, success, research, reliability) → memory/ledger → morning report. Hard cost ceiling and function-level approval gates from day one. |
| 19 | Product shape: blueprints · plans · Perplexity · HQ test bench | 📋 queued — `docs/queue/SAILZ-CURSOR-PROMPT-19.md`. Makes `brain/blueprints/*.json` load-bearing (per-vertical agent roster + tabs + primary agent), enforces plan limits/metering, swaps research to Perplexity with citations and per-plan quota, turns HQ into the bench every agent must pass before touching a client, wires the website's lead form into HQ. Run after 18. |
| 20 | **Sailz runs on Sailz** (run this first) | 🔨 in progress — full honest status in `docs/HQ-FIRST-RUN.md`. **Verified live**: the site's Haiku chat (real multi-turn conversation through the browser UI, correct real pricing, produces a real qualified lead with transcript + cost logged, 4 real bugs found and fixed by actually running it — tool-use text loss, contact-field parsing, phone-regex, em dashes); `public/js/brain-map.js` (dashboard's map engine extracted, verified against a live Shine Dental boot, one real regression caught — `PAL` out of scope in the theme toggle — and fixed); `server/research.js` (Perplexity + citations-or-unavailable contract, 30-day cache, ICP lead sourcing with the mobile-number hard gate, all verified with a mocked provider); client isolation (every HQ route 404s on a plain client instance). **Blocked on credentials, not code**: real inbound/outbound calling (no Vapi/Twilio/GCal for sailz-hq yet), real lead sourcing (no PERPLEXITY_API_KEY yet), any dialable HQ-sourced number (no phone-type lookup provider configured — fails closed by design). **Known debt, not silently dropped**: `site/map.js` and `public/js/brain-map.js` are two independent map implementations, not the one shared module the spec asked for — reconcile later. |
| 5 | Case threads | 🗂 parked (docs/queue/) |

## Company (not code)

| Thing | Where | State |
|---|---|---|
| Pricing & packaging | `docs/SAILZ-PRICING.md` | ✅ Solo $199 / Business $499 / Multi $999, setup fees, real COGS + margin per tier, break-even table, quoting script. Stripe products still to be created. |
| Vertical blueprints | `docs/VERTICAL-BLUEPRINTS.md` + `brain/blueprints/*.json` | ✅ five verticals defined (dental, restaurant, financial-services, hospitality, local-service) + hq. JSON exists; engine doesn't read it yet — that's prompt 19 stage 1. |
| Marketing website | `site/` + `server/siteHost.js` | ✅ built, verified (311 site assertions, 22 server assertions, 4 client-isolation assertions, plus Chrome). **Served from the HQ Railway service**, host-routed: sailz.org gets the site, hq.sailz.org keeps the dashboard, /site/ previews it before DNS. Live lead endpoint at POST /api/site/lead. Deploy runbook: `docs/SITE-DEPLOY.md`. Needs `SITE_ENABLED=1` + `SITE_HOSTS` on the hq service and two grey-cloud CNAMEs in Cloudflare. |
| Privacy + Terms | `site/privacy.html`, `site/terms.html` | ⚠️ written, not lawyer-reviewed. Read before publishing; Stripe will need both live. |

Executed prompts: `docs/archive/` · Strategy docs: `docs/` ·
Per-client briefs + demo runbook + pilot agreement: `clients/` ·
Instance config: `instances/`

## Clients

| Client | Stage | Next action |
|---|---|---|
| Shine Dental | LIVE | keep librarian approvals flowing; case-study stats |
| The Burg | Vapi wired, menu items in | fill $TBC prices → 5 test calls → demo + pilot signing |
| Retirement Plan Resource Group | Deployed to Railway (`rprg`), sandboxed — calling agent paused, no real calls placed | DNS (`rprg.sailz.org`), Jay wires the Vapi Server URL himself, Mutual of America compliance + TCPA sign-off, then supervised QA before any demo |
| Car wash | discovery | book discovery call; instance is ~an afternoon |
| Myrtle hotels | proposal | Lead Engine (prompt 10) shipped — RFP pitch unblocked, ready to send |

## Infrastructure (Railway, verified 5 Aug)

| Service | Domain | Volume | State |
|---|---|---|---|
| `sailz-hq` | hq.sailz.org **+ sailz.org** | sailz-hq-volume | Online |
| `clinic` | shine.sailz.org | clinic-volume | Online |
| `the-burg` | theburg.sailz.org | the-burg-volume | Online |
| `rprg` | rprg.sailz.org | **rprg-volume (attached 5 Aug)** | Online |

**rprg volume fixed.** It was the only service with no volume, which is why
every redeploy wiped the client's imported leads: `DB_PATH=/app/data/db.json`
was writing to an ephemeral container filesystem. A volume is now mounted at
`/app/data` (us-west2, matching the service region). Nothing was lost in the
fix, because the redeploy an hour earlier had already cleared that container.

Two follow-ups for Jay:

1. **The leads still need re-importing.** The volume stops it happening
   again; it does not bring back what was already gone.
2. **Aman's password may have reset.** A fresh volume means an empty
   `/app/data`, so the first boot re-seeds the owner login from
   `OWNER_EMAIL` / `OWNER_PASSWORD`. If he had set his own password in the
   dashboard, it is back to the environment one. Worth telling him before
   he tries to log in.

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
