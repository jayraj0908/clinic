# Prompt for Cursor / Claude Code — PRODUCT SHAPE: blueprints, plans, Perplexity, HQ test bench

Run **after** prompt 18 (HQ Autonomous Operations), or alongside it if 18
is still in flight — Stage 6 here is the only part that touches 18's
work, and it degrades cleanly when 18 hasn't landed.

Self-contained. Work stage by stage, indefinitely, until Stage 7 passes.
Commit per stage. Copy everything below the line.

---

You are working on **Sailz** (this repo), a live multi-client AI platform
with real phone traffic. This build turns Sailz from "an app we
reconfigure per client" into **a product with a shape**: every vertical
has a blueprint, every plan has enforced limits, every instance gets a
dashboard tailored to what its agents actually produce, and every agent
is proven on Sailz's own instance before a paying client ever sees it.

Read first, in order: `docs/VERTICAL-BLUEPRINTS.md` (the contract for
this build), `docs/SAILZ-PRICING.md` (the plan definitions),
`brain/blueprints/*.json`, `server/instance.js`, `server/brain.js`,
`server/catalog.js`, `server/researcher.js`, `server/brainGraph.js`, the
tab-gating block in `public/index.html` (~line 1314), every
`instances/*/instance.json`, and `site/README.md`.

## Non-negotiable constraints

1. **No live client's behaviour changes without an explicit decision
   recorded in this repo.** Blueprints must reproduce today's config for
   shine-dental exactly. The Burg and RPRG *do* change (that's the
   point), and each change is listed in Stage 2 — make those and no
   others.
2. **Every phone/dialer guardrail survives untouched**: quiet hours, DNC,
   consent basis, concurrency caps, attempt caps, approval gates. If a
   refactor makes a guardrail easier to bypass, the refactor is wrong.
3. **Research never becomes a source of dialable numbers or personal
   contact data.** Business information only, every claim carries a
   source URL, `unavailable` beats a guess.
4. Flags: `BLUEPRINTS=1`, `PLAN_LIMITS=1`, `PERPLEXITY_ENABLED=1`,
   `HQ_TESTBENCH=1`. Default off; enable per-service as each stage is
   verified.
5. Small commits per stage. `node --check` every changed file. Never
   print secrets. Full client regression after EVERY stage.

---

## Stage 1 — Blueprints become real (the engine reads them)

`brain/blueprints/<vertical>.json` already exists. Make it load-bearing.

- `server/blueprint.js`: loads the blueprint for `instance.vertical` and
  resolves the effective config with clear precedence —
  **instance.json wins → blueprint fills the gaps → engine default is the
  last resort.** Export `resolved()` returning `{primary, coPrimary,
  agents, dormant, tabs, kpis, plan, compliance}`.
- `server/instance.js` exposes the resolved config; `catalog.js`'s
  `getActiveAgentIds()` fallback chain gains the blueprint step *between*
  instance.json's `agents` and the implicit-all-active fallback. Do not
  disturb the existing `db.activeAgents` precedence — an owner's real
  activation choice still beats everything.
- Boot validation: an unknown vertical, or a blueprint naming an agent
  that doesn't exist, logs a loud warning and falls back to today's
  behaviour rather than booting a broken roster.
- `GET /api/blueprint` (authed) returns the resolved config for the
  frontend.

**Verify:** for each of the four live instances, print resolved config
and diff it against what the app computes today. shine-dental must be
byte-identical. Assert this in a test so a future blueprint edit can't
silently re-shape a live client.

## Stage 2 — Tailored dashboards (the decluttering)

Today every instance shows nearly every tab. Fix it.

- Tabs come from the resolved blueprint. The frontend's existing
  `instance.tabs` gate keeps working; blueprint fills it when
  instance.json is silent.
- **The primary agent gets hero treatment**: it opens centred and
  expanded on the map, its panel is what Simple Mode's main card links
  to, and the dashboard's top-line stat is its KPI — not a generic call
  count.
- **Home tab per vertical.** Not everyone lands on Dash. RPRG lands on
  **Leads** (their product is a pipeline). The Burg lands on **Orders**.
  Add `homeTab` to the blueprint schema and honour it.
- Empty surfaces stop lying: a tab whose data source is empty *and*
  whose feeding agent isn't active shows a one-line "this turns on when
  you activate X" instead of an empty table.

**The specific changes to live clients — make exactly these:**

| Instance | Change |
|---|---|
| `the-burg` | drop `leads` and `calendar` tabs; home tab → `orders` |
| `retirement-plan-resource-group` | home tab → `leads`; keep all current tabs |
| `shine-dental` | **no change** |
| `sailz-hq` | tabs become `dash`, `clients`, `pipeline`, `money`, `teach`, `work` (Stage 5) |

**Verify:** each instance renders only its blueprint's tabs; primary
agent is centred and expanded on first load; home tab is correct; no
tab-less dead route is reachable by typing a URL.

## Stage 3 — Research module (Perplexity, shared by every instance)

Replace the ad-hoc fetch-and-summarize in `server/researcher.js` with a
real, budgeted, provider-agnostic module.

- `server/research.js`: one interface, pluggable providers.
  **Perplexity is the default** (`PERPLEXITY_API_KEY`,
  `https://api.perplexity.ai/chat/completions`). Keep the existing
  direct-fetch path as the fallback provider so a missing key degrades
  instead of breaking.
- Model routing by job, because these bill differently: **`sonar`** for
  lead/company enrichment (high volume, cheap — roughly $1/M tokens plus
  a per-request search fee) and **`sonar-pro`** for HQ strategy and
  market research (low volume, worth $3/$15 per M). Record which model
  ran, tokens used, and request count on every call.
- **Citations are mandatory.** Perplexity returns a `citations` array —
  store it, surface it, and drop any claim you can't attach a source to.
  A summary with zero citations is treated as `unavailable`.
- Cache by normalized query + domain, 30 days, shared per instance.
- **Quota per plan**, enforced server-side, from `docs/SAILZ-PRICING.md`:
  Solo 100/mo, Business 500/mo, Multi 2,000/mo. At 80% the owner sees a
  notice; at 100% research queues rather than billing silently.
- Wire it into: the `researcher` agent (lead enrichment), the calling
  agent's pre-call context (**only for leads that already carry a
  consented `consentBasis`** — keep that check), and HQ's Research
  specialist if prompt 18 has landed.

**Verify:** live key → real cited summary; no key → falls back, no crash;
known-company fixture → sources present; nonsense company → `unavailable`
with no invented facts; cache hit on repeat; quota exhaustion queues
instead of spending; an unconsented lead still cannot be dialed.

## Stage 4 — Plans and metering (make the pricing real)

- `server/plans.js` encoding Solo/Business/Multi from
  `docs/SAILZ-PRICING.md`: price, included minutes, overage rate, agent
  cap, number cap, research quota, location cap.
- Meter **talk minutes** from actual call durations (both directions,
  excluding `test:true` rows) into a monthly usage record per instance.
- Owner-visible usage: a small "this month" strip — minutes used vs
  included, research lookups, days left. Honest, not alarming.
- At 80% of included minutes: notice in the dashboard + the weekly email.
  At 100%: overage starts and is *stated plainly* before it accrues.
  Never silently cut off a live phone line — a business that can't answer
  its phone because of a billing threshold is a worse outcome than a
  bill.
- Agent-cap enforcement at activation time: activating past the plan's
  agent cap explains the limit and offers the upgrade, rather than
  failing opaquely.
- Emit per-instance usage to HQ's heartbeat so the Finance agent
  (prompt 18) can reconcile it against Stripe.

**Verify:** synthetic call volume crosses 80% and 100% and produces
exactly the right notices; test calls are excluded from metering; agent
cap blocks the 4th agent on Business with a clear message; the line stays
up past 100%.

## Stage 5 — HQ becomes the test bench and Sailz's own client

Two jobs, both real.

**5a. Test bench.** `HQ_TESTBENCH=1` on sailz-hq only.
- A `/hq/bench` surface listing every agent in the catalog with: has it
  ever run on HQ, when, last result, last cost, and pass/fail of a
  scripted smoke run.
- `POST /api/hq/bench/:agentId/run` executes an agent against **HQ's own
  data** in a sandboxed mode: no client data readable, no outbound
  send/call without the same approval gate a client has.
- A per-agent smoke script (fixtures in `brain/agents/<id>.bench.json`)
  asserting the agent's core promise — receptionist books a fixture
  appointment, researcher returns a cited summary, rfp-responder drafts
  from a fixture email, and so on.
- **The gate that matters:** record `benchedAt`/`benchResult` per agent.
  Activating an agent on a *client* instance whose bench has never passed
  logs a prominent warning and requires an explicit override flag on the
  request. This is the "a client instance is never the first place an
  agent runs" rule from the blueprints doc, enforced.

**5b. Sailz runs on Sailz.** Give sailz-hq the `hq` blueprint from
`docs/VERTICAL-BLUEPRINTS.md`: chief-of-staff primary, the six
specialists, tabs `dash · clients · pipeline · money · teach · work`.
HQ gets its own receptionist on Sailz's own sales number and its own
calling agent for its own outbound — same engine, same guardrails, no
special cases. If Sailz's brain can't book Sailz's discovery calls, the
demo is a lie.

**Verify:** bench runs every catalog agent on HQ and reports honestly;
an unbenched agent activated on a client instance produces the warning
and demands the override; HQ's own receptionist books a real fixture
appointment through the identical code path a client uses; `/api/hq/*`
still 404s on all three client instances.

## Stage 6 — Website lead capture (into HQ, into Growth)

The marketing site is built and static (`site/`, see `site/README.md`).
Give it somewhere to send a form.

- `POST /api/site/lead` on HQ only: rate-limited, no auth, strict schema
  (`name, business, email, phone?, vertical, message?`), spam-resistant
  (honeypot + timing + per-IP cap), stores as a lead on HQ with
  `source: "website"`.
- Notify: email to the owner immediately. If prompt 18's Growth agent
  exists, hand the lead to it for enrichment + a drafted reply that waits
  in the approval queue. **If prompt 18 hasn't landed, just store and
  notify — no hard dependency.**
- Add `window.SAILZ_LEAD_ENDPOINT` to `site/index.html` per its README.
  The mailto fallback stays as the failure path.
- Add a `predeploy` check that runs `node scripts/build-site-data.mjs`
  and fails if `site/data.js` is stale relative to `brain/agents/` or
  `brain/blueprints/` — the site must never describe agents we don't have.

**Verify:** valid submission lands as an HQ lead and emails the owner;
malformed/spam submissions rejected; endpoint 404s on client instances;
endpoint down → the site's mailto fallback still works; stale `data.js`
fails the predeploy check.

## Stage 7 — Final verification (all must pass)

```bash
# Blueprints: resolved config for all 4 instances matches the intended
#   table above; shine-dental byte-identical to pre-change; unknown
#   vertical degrades with a warning, never a broken roster
# Tabs: each instance renders exactly its blueprint's tabs; primary agent
#   centred + expanded; homeTab honoured; no reachable dead route
# Research: cited summaries or `unavailable`, never a guess; quota
#   enforced at 80/100%; unconsented lead still undialable; missing key
#   degrades to fallback provider
# Plans: metering accurate against a known set of call durations; test
#   calls excluded; agent cap enforced; phone line stays up past 100%
# Bench: every catalog agent has a bench result on HQ; unbenched agent on
#   a client requires the override flag
# Isolation: /api/hq/*, /api/site/lead, /hq/bench all 404 on shine, burg,
#   rprg. Full client regression green on all three (inbound calls,
#   orders, dialer pacing + DNC + quiet hours, memory approvals, auth).
# Site: data.js regenerates clean; blueprint referencing a missing agent
#   fails the build; every agent node opens a panel matching its .md
node --check every changed file
# Update STATUS.md, docs/VERTICAL-BLUEPRINTS.md ("Current assignments"),
# and docs/SAILZ-PRICING.md if any limit shipped differently than specced.
```

## Working style

Work stage by stage without waiting for approval between stages. Stop and
report ONLY if: a stage's verification fails twice, a live client's
behaviour would change beyond the Stage 2 table, a real cost or legal
risk appears, or you need a credential. Otherwise keep building. Prefer
boring, testable code — this system answers real phones for real
businesses.

## Out of scope (deliberately)

Changing what any live phone line says; new verticals beyond the five
blueprinted; paid data providers (Apollo/ZoomInfo); personal-contact
enrichment; self-serve signup and payment (that's a later prompt, after
Stripe from 18 is proven); anything that removes an approval gate.
