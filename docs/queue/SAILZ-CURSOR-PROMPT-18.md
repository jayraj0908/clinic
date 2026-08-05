# Prompt for Cursor / Claude Code — HQ AUTONOMOUS OPERATIONS (the big one)

Self-contained. Work through it stage by stage, indefinitely, until every
verification in Stage 9 passes. Commit per stage. Report at each stage
boundary but keep going unless something is genuinely blocked or a stage
verification fails. Copy everything below the line.

---

You are working on **Sailz** (this repo), a live multi-client AI platform
with real phone traffic. You are building **Sailz HQ Autonomous
Operations**: the system that runs the Sailz company itself — finding
clients, marketing, invoicing, monitoring every client instance, and
reporting to the founder each morning.

Read first, in order: `docs/HQ-AUTONOMY-SPEC.md` (the architecture and
autonomy tiers — this is the contract), `STATUS.md`, `docs/SAILZ-THESIS.md`,
`docs/SAILZ-PLAYBOOK.md`, `instances/sailz-hq/`, `server/brain.js`,
`server/catalog.js`, `server/dialer.js` (guardrail patterns),
`server/heartbeat`-related code, `public/admin.html`, `clients/*.md`.

## Non-negotiable constraints

1. **HQ-only.** `INSTANCE=sailz-hq` + `SAILZ_ADMIN=1` gates every route,
   agent, and page you add. Zero behavior change for shine-dental,
   the-burg, rprg. Run the full client regression after EVERY stage.
2. **Autonomy tiers from the spec are enforced in code**, not prompts.
   Tier 2 actions are physically impossible without an approval record:
   the executing function must take an `approvalId` and verify it.
3. **Cost ceiling is real.** `HQ_MONTHLY_BUDGET` (default 200 USD).
   Every agent call logs estimated+actual cost. At 80% spend, Tier-1
   work queues instead of running. At 100%, only Reliability runs.
   No exceptions, no overrides in code.
4. **Every outbound artifact is attributable.** Any draft an agent
   produces stores: which agent, which task, what sources, what it cost.
5. Feature-flag the whole subsystem: `HQ_AUTONOMY=1`, default off.
6. Small commits per stage. `node --check` everything. Never print
   secrets.

## Stage 1 — Task system + ledger (the spine)

- `server/hq/taskSystem.js`: tasks with `{id, agent, goal, scope,
  tier, status, budgetCents, actualCents, input, output, sources,
  createdBy, approvalId, error, retries}`. Statuses: queued → running →
  awaiting_approval → done/failed/cancelled.
- Scheduler: a worker loop (interval, HQ-only) that pulls queued tasks
  respecting per-agent concurrency (default 1) and global budget state.
- `server/hq/ledger.js`: cost accounting per task/agent/day/month, with
  `budgetState()` returning ok | throttled | frozen.
- Model routing helper: cheap model for classify/triage/extract,
  frontier model for strategy/drafting. Record which was used.
- API: `GET /api/hq/tasks`, `POST /api/hq/tasks` (owner), `GET
  /api/hq/ledger`. Verify: tasks execute, costs land, throttle works at
  a forced-low budget.

## Stage 2 — Chief of Staff (strategist / chat agent)

- `brain/agents/hq-chief-of-staff.md` + `server/hq/chief.js`.
- `POST /api/hq/chat` (owner): a conversation that (a) reads HQ memory +
  live metrics + client health, (b) answers strategy questions, (c)
  CREATES TASKS for specialists, (d) **pushes back** — it must be
  instructed to challenge weak ideas and say when something is a bad use
  of money or time. Polsia's chat agent does this deliberately; so does
  ours.
- Daily planning run (cron 6am): review yesterday, set today's task
  slate within budget, note what it decided and why in memory.
- Verify: chat creates real tasks; the planner produces a coherent slate;
  pushback happens on a deliberately bad request fixture.

## Stage 3 — Memory + company brain for HQ

- HQ's own memory: company context (thesis, pricing, ICP per vertical,
  positioning), decision log (what was decided, when, why, outcome),
  founder voice profile (learned from Jay's approved drafts), and
  per-client narrative state.
- Every specialist reads memory before acting; every meaningful outcome
  writes back a fact (proposed → auto-approved for internal facts,
  owner-approved for anything client- or public-facing).
- Verify: a decision made Monday is referenced correctly on Wednesday;
  voice profile visibly shapes drafts.

## Stage 4 — Reliability agent (protect what exists first)

- `brain/agents/hq-reliability.md` + monitors: for every registered
  client instance — heartbeat gaps during business hours, webhook
  silence, dialer rejects, scheduler dead, volume-missing detection,
  deploy verification (does the live build contain the commit we think?),
  and a **demo-path check** (login → key tabs → key controls render).
- Self-heal Tier 0: retry, re-arm schedules, re-poll, clear caches.
  Escalate anything destructive.
- Alerting: Tier-1 issues → morning report; Tier-2 (client is DOWN,
  data-loss risk, unauthenticated webhook detected) → immediate SMS via
  Twilio + email.
- Verify with fault injection: kill a mock client, break a secret, stop a
  scheduler — each is detected, classified, and either healed or paged.

## Stage 5 — Finance agent (money in, automatically)

- Stripe integration: customers, subscriptions per client per the agreed
  price, invoices, dunning sequence, receipts. Idempotent everywhere.
- Autonomous: create/send invoices on agreed terms, retry failed
  payments, reconcile, compute MRR/ARR/churn/LTV/CAC/margin, per-client
  API cost from the ledger + provider usage.
- Approval-gated: price changes, refunds, anything paying money OUT.
- Investor-grade metrics endpoint + a `/hq/metrics` page: MRR chart,
  cohort retention, per-client unit economics, runway. This doubles as
  the fundraising data room.
- Verify against Stripe test mode: full lifecycle, dunning, idempotency
  under duplicate calls, refund blocked without approvalId.

## Stage 6 — Growth + Content agents (pipeline, human-gated at send)

- Growth: ICP definition per vertical from won-client patterns; find
  candidate businesses from public sources (no personal-contact
  harvesting, business info only, sources recorded); score fit; draft
  personalized outreach referencing real, cited facts; build a pipeline
  board with stages; prep call briefs before每 meeting.
- Content: weekly content from REAL client outcomes (numbers from the
  ledger/metrics, never invented), case studies, landing page copy,
  social posts, the investor update draft. Founder voice from memory.
- Everything lands in an approval queue as ready-to-send drafts. Sending
  and publishing are Tier 1 (batch approve). Nothing auto-sends.
- Verify: drafts cite sources; no personal data harvested; approve→send
  path works; reject→feedback improves the next draft (store the edit).

## Stage 7 — Success agent (keep what exists)

- Per-client health (usage trend, agent errors, owner login recency,
  approval-queue rot), weekly client-facing report drafts, QBR packs,
  churn-risk flags with a recommended action, and an onboarding-progress
  tracker for clients mid-provisioning.
- Verify: a synthetically degrading client raises risk correctly; report
  drafts contain accurate numbers only.

## Stage 8 — The morning report + approval queue (the product mechanic)

- 8am daily: one page — **what happened** (agent work, client activity,
  money), **what it learned** (memory writes, insight), **what needs you**
  (batched Tier-1/2 approvals, each one-tap), **what it plans today**,
  and the two north-star numbers: founder-minutes-yesterday and
  MRR-per-founder-hour. Cost summary in a line.
- Delivered as: HQ page, email, and an SMS one-liner if anything is
  Tier 2 or a client is down.
- Approvals: batch approve/reject with optional edit; every decision
  writes to memory so the system learns your preferences over time.
- Verify: end-to-end day simulation — seed activity, run the cycle,
  confirm the report is accurate, approvals execute, rejections teach.

## Stage 9 — Final verification (all must pass)

```bash
# Tier enforcement: attempt every Tier-2 action without approvalId →
#   refused at the function level (not just UI); with approvalId → runs
# Budget: force 80% → Tier-1 queues; 100% → only Reliability runs
# HQ isolation: all /api/hq/* → 404 on shine/burg/rprg; full client
#   regression green on all three (calls, orders, dialer, memory, auth)
# Cost ledger: every task has estimated+actual; daily/monthly rollups
#   reconcile; cheap-model routing verified on triage tasks
# Reliability: 5 fault injections detected + classified + healed/paged
# Finance: Stripe test-mode lifecycle incl. dunning + idempotency;
#   refund/price-change blocked without approval
# Growth/Content: zero unapproved sends possible (assert by attempting);
#   every claim in a draft traces to a source or a real metric
# Memory: decisions persist and are cited; voice profile affects output
# Morning report: numbers match ground truth from the DB, not estimates
# 24h soak on HQ with HQ_AUTONOMY=1: no runaway loops, no budget
#   overrun, no client impact, report generated correctly
node --check every changed file; update STATUS.md + the spec doc with
what shipped and what's deliberately deferred.
```

## Working style for this build

Work stage by stage without waiting for approval between stages. Stop and
report ONLY if: a stage's verification fails twice, you must touch client
(non-HQ) behavior, a real cost or legal risk appears, or you need a
credential. Otherwise keep building. Prefer boring, testable code over
clever abstractions — this system spends money and talks to customers.

## Out of scope (deliberately)

Autonomous outbound sends without approval, autonomous spending outside
the ceiling, contract/legal commitments, changing live client phone-line
speech, acquiring clients' credentials, anything that removes the
founder's approval on Tier-2 actions.
