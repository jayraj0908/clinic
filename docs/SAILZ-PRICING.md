# Sailz — Pricing & Packaging

*Source of truth for what Sailz charges and why. The website, the pilot
agreement, Stripe products, and the Finance agent all read from this.*

---

## The three plans

| | **Solo** | **Business** | **Multi** |
|---|---|---|---|
| **Price** | **$199/mo** | **$499/mo** | **$999/mo** |
| Setup (one-time) | $500 | $500 | $1,500 |
| Who it's for | One operator. A consultant, an agent, a one-chair practice. | One location with a front desk and real phone volume. | Multi-location, hotel groups, franchises, anyone with more than one P&L. |
| Live agents | 1 primary + Librarian | up to 3 + Librarian | unlimited |
| Included talk minutes | 300/mo | 1,000/mo | 2,500/mo |
| Overage | $0.35/min | $0.30/min | $0.25/min |
| Phone numbers | 1 | 2 | 1 per location (up to 3 incl.) |
| Locations | 1 | 1 | up to 3, then +$249/location |
| Research (Perplexity) | 100 lookups/mo | 500/mo | 2,000/mo |
| Dashboard | Simple Mode + full map | + Calls, Leads, Calendar/Orders | + cross-location roll-up |
| Memory / Teach | ✅ | ✅ | ✅ |
| Support | email, next business day | email + SMS, same day | shared Slack channel, 4h |
| Reporting | weekly email | weekly + monthly review | weekly + monthly QBR |

Annual: pay 10 months, get 12. (Cash up front is worth more to us than
the 17% — it funds the next client build.)

**Example placements today:** RPRG (Aman, one consultant, outbound) →
Solo. Shine Dental → Business. The Burg → Business. Myrtle Beach hotel
group → Multi, then per-property expansion.

---

## What every plan includes (never unbundled)

- Their own deployment, own logins, own phone config, own data
- The brain map — every agent visible, what it did, when
- Memory + Teach: they correct the agent once, it stays corrected
- Approval gates on anything consequential (nothing sends itself)
- Emergency fallback: if the AI fails, calls forward to a human number
- Honest-limits review before go-live — we say out loud what it can't do

## Add-ons

| Add-on | Price | Notes |
|---|---|---|
| Extra location | $249/mo | Multi plan only |
| Outbound dialer (Solo/Business) | +$149/mo | included in Multi |
| Extra agent beyond plan | $99/mo | |
| Custom integration (PMS, POS, CRM) | $1,500 one-time + $99/mo | scoped first |
| Compliance pack (FINRA/HIPAA review, A2P registration) | $750 one-time | RPRG-type clients |

---

## Unit economics (the part most agencies skip)

Blended voice cost is **~$0.15/min all-in** — Vapi orchestration $0.05,
STT ~$0.01, Claude ~$0.03, ElevenLabs ~$0.04, Twilio ~$0.015. Short
scripted calls run cheaper (~$0.10); long consultative ones run to
$0.20+. Planning at $0.15 with $0.18 as the stress case.

| | Solo $199 | Business $499 | Multi $999 |
|---|---|---|---|
| Voice (included mins × $0.15) | $45 | $150 | $375 |
| Numbers + SMS | $3 | $8 | $15 |
| Agent tokens (non-voice) | $8 | $20 | $45 |
| Perplexity research | $5 | $18 | $55 |
| Hosting (Railway service + volume) | $10 | $10 | $20 |
| **COGS** | **$71** | **$206** | **$510** |
| **Gross margin** | **$128 (64%)** | **$293 (59%)** | **$489 (49%)** |

At the $0.18 stress case: 59% / 50% / 40%. Still viable, but Multi is
where margin dies first — which is why Multi charges per location rather
than pretending one price covers ten properties.

**Rules that keep this true:**

1. **Included minutes are a real cap, enforced in code.** At 80% of
   included minutes the owner gets a heads-up; overage bills
   automatically. An unmetered plan is how you end up like Polsia,
   losing money on every customer.
2. **Solo is gated to genuinely low volume.** A busy dental practice
   does 300 minutes in nine days. If discovery shows >250 min/mo of real
   phone traffic, they are a Business client — quote them that way or
   the plan loses money by month two.
3. **Setup fee is not a discount lever.** It pays for the build week. If
   a prospect won't pay setup, they won't pay month three either.
4. **Per-client COGS is tracked live** by the HQ Finance agent against
   the ledger. Any client whose margin drops under 40% shows up in the
   morning report with a recommendation (upgrade, cap, or exit).

---

## Break-even and the shape of the business

Fixed monthly cost today is roughly $150 (base hosting, HQ, tooling)
plus whatever HQ's own API budget is set to (`HQ_MONTHLY_BUDGET`,
default $200). Call it **$350/mo of floor**.

| Clients | Mix | MRR | Gross profit |
|---|---|---|---|
| 3 (today's shape) | 1 Solo, 2 Business | $1,197 | ~$714 |
| 10 | 3 Solo, 6 Business, 1 Multi | $4,584 | ~$2,634 |
| 25 | 6 Solo, 15 Business, 4 Multi | $12,675 | ~$7,209 |
| 50 | 10 Solo, 30 Business, 10 Multi | $26,980 | ~$15,020 |

Setup fees are on top and are the real early cash: 10 new clients at
$500 is $5,000 in the month they sign.

The number that matters for fundraising isn't MRR, it's **MRR per
founder hour**. Fifty clients only works if onboarding is a wizard and
monitoring is an agent — which is exactly what HQ is being built to do.

---

## How to quote (discovery → plan, in one question)

> "Roughly how many calls a week does someone have to answer, and what
> happens to the ones nobody picks up?"

- Under ~20 calls/week, one person → **Solo**
- 20–150 calls/week, one location → **Business**
- More than one location, or a group → **Multi**
- "We don't get calls, we need to *make* them" → Solo/Business + the
  outbound dialer add-on

Never quote hourly. Never quote per-agent. The client is buying a
brain, not seats.

## What we do not do

- No free tiers. A 15-day pilot, then a paid plan. (Pilot terms:
  `clients/PILOT-AGREEMENT-TEMPLATE.md`.)
- No month-to-month discounting to save a churning account — fix the
  product problem or let them go.
- No custom pricing below Solo. If they can't justify $199 against one
  missed call, they are not a customer yet.
