# Sailz HQ — Autonomous Operations Spec (Polsia pattern)

## What we're copying, and why it works

Polsia (Ben Broca, solo founder, zero employees, ~$1M ARR in a month,
$30M raised at $250M) runs on four ideas worth stealing verbatim:

1. **Start with the end state.** Build the whole loop incomplete rather
   than perfecting components. Integration creates value faster than
   optimization.
2. **The system operates when the user does nothing.** It works
   overnight and sends a morning report. That report IS the product
   mechanic — it re-engages, it proves progress, it turns the human from
   operator into supervisor.
3. **Constrained agents, not one god-agent.** A strategist/chat agent
   decides → a task system translates decisions into scoped work →
   specialist agents execute with limited tools. He does this explicitly
   to avoid runaway cost and unpredictable behavior.
4. **Memory layer**: company context, past decisions, founder
   personality — so output is consistent and sounds like the company.

## What we're NOT copying

- **His unit economics.** "I lose money on every customer today" — his
  words. He scaled usage before cost control and had to pause features
  to fix it. Sailz starts with a hard monthly ceiling and per-task cost
  logging from day one.
- **Unbounded autonomy on consequential actions.** Even Polsia scopes
  agents tightly. Sailz has additional exposure he doesn't: live phone
  lines, TCPA, patient-adjacent data, financial-services compliance.

## The Sailz HQ architecture

```
                    ┌──────────────────┐
   You (chat/voice) │  CHIEF OF STAFF  │  strategist · plans · challenges
                    │   (chat agent)   │  reads memory, sets goals
                    └────────┬─────────┘
                             │ creates
                    ┌────────▼─────────┐
                    │   TASK SYSTEM    │  queue · scope · budget · retries
                    └────────┬─────────┘
        ┌──────────┬─────────┼─────────┬──────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼          ▼
     GROWTH     CONTENT   FINANCE   SUCCESS   RESEARCH   RELIABILITY
     find/      write     invoice   monitor   market/    watch every
     qualify    posts,    Stripe,   clients,  investor   client
     prospects  cases,    dunning,  QBRs,     intel      instance,
                emails    MRR       churn                self-heal
        └──────────┴─────────┬─────────┴──────────┴──────────┘
                             ▼
                    ┌──────────────────┐
                    │  MEMORY + LEDGER │  company context, decisions,
                    │                  │  voice,每 task cost, outcomes
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐
                    │  MORNING REPORT  │  what happened · what it learned
                    │  + APPROVAL QUEUE│  · what needs you (batch approve)
                    └──────────────────┘
```

## The six specialist agents

| Agent | Runs autonomously | Needs approval |
|---|---|---|
| **Growth** | research targets, score fit, draft outreach, build lists, prep demos | sending anything to a named human |
| **Content** | draft posts/case studies/emails/landing copy from real client data | publishing publicly |
| **Finance** | Stripe invoices, subscriptions, dunning, receipts, MRR/churn/margin math, per-client cost tracking | changing prices, refunds, any outbound money |
| **Success** | health scores, usage digests, QBR prep, churn-risk flags, client weekly reports | anything emailed to a client |
| **Research** | market/competitor/investor intel, accelerator deadlines, ICP refinement | — (read-only) |
| **Reliability** | watch every client instance, detect silent failures, restart/re-arm, verify deploys, run the demo-path check | destructive ops |

## Autonomy tiers (the honest version)

- **Tier 0 — runs freely:** research, drafting, monitoring, self-healing,
  internal analysis, invoicing existing clients on agreed terms.
- **Tier 1 — batch approve in the morning report:** outbound to named
  humans, public posts, client-facing emails, new spend under the cap.
- **Tier 2 — explicit approval, always:** money out, price changes,
  contracts, anything altering a live phone line's speech, legal
  commitments, new client go-live.

## Cost control (Polsia's mistake, avoided)

- `HQ_MONTHLY_BUDGET` hard ceiling; every task logs estimated + actual
  token cost to a ledger.
- Task scoping: cheap model for classification/triage, expensive model
  only for drafting and strategy.
- Auto-throttle at 80% of budget: Tier-0 continues, Tier-1 queues.
- Weekly cost-per-client and cost-per-outcome in the report — if an
  agent's cost exceeds its value, the report says so plainly.

## Success metric

Not "how autonomous is it." The metric is: **founder minutes per day**
(target < 15, spent on the approval queue) and **MRR per founder hour**.
Both go in the morning report, tracked over time.
