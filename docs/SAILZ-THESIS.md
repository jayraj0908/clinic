# SAILZ — Thesis, User Stories, and What's Actually Required

*Companion to SAILZ-PLAYBOOK.md. Written against the "autopilot" essay
(software company masquerading as a services firm).*

## Where Sailz sits in the essay's framework

The essay's test: do you sell the tool, or do you sell the work?
**Sailz sells the work.** Not "here's an AI receptionist app" (copilot —
racing the model), but "your phone gets answered, your schedule stays full,
your claims get drafted" (autopilot — every model improvement makes us
faster and cheaper).

Run the playbook checklist against dental:

1. **Already-outsourced, intelligence-heavy wedge?** Yes — clinics already
   pay $300–1,500/mo for after-hours answering services, and separate
   vendors for recall/reminder campaigns. Replacing that is a vendor swap,
   not a reorg. Existing budget line. That is our receptionist + calling +
   reminders stack, live today.
2. **Long-term TAM in the insourced/judgement direction?** Yes — and it's
   literally on the essay's opportunity map: **healthcare revenue cycle,
   $50–80B outsourced, "almost pure intelligence."** Dental billing (CDT
   coding, claims, denials) is that market's dental slice. Our audit +
   billing agents are already pointed at it, with the human approval gate
   that makes it safe to sell.
3. **The convergence moat?** The librarian/memory layer is exactly the
   essay's "accumulate proprietary data about what good judgement looks
   like." Every approved fact, every corrected claim code, every booking
   pattern per clinic is judgement data nobody else has.

So the one-line thesis:

> **Sailz is the front-office autopilot for dental today, and the dental
> revenue-cycle autopilot tomorrow — delivered as a managed AI brain, with
> the owner as the judgement layer.**

## "Are millions of people doing the same thing?"

Honestly: thousands are building AI receptionists; the essay is widely
read; the idea is not the moat. But note three things. Most competitors
sell the *tool* to the clinic (copilot posture — the clinic still operates
it). Almost none deliver the full pipeline (phone → booking → recall →
notes → claims) as one organism with memory. And in local-business
services, **distribution beats invention**: the winner in dental autopilots
will be whoever gets 50 referenceable clinics first, not whoever had the
idea. Shine Dental is client #1 of that race. Ideas are shared; execution
speed, vertical depth, and accumulated judgement data are not.

## User stories — the WHO and WHY

**Dr. Shah, owner-dentist (the buyer).**
As a practice owner, ~30% of my calls go to voicemail and every missed new
patient is a $400–1,500 lifetime loss; no-shows cost me another ~$200 each.
I want the phone answered 24/7, the schedule kept full, and claims drafted
clean — without hiring, training, or managing anyone new — so revenue stops
leaking while I'm doing dentistry. *I buy outcomes, not software.*

**Maria, office manager (the daily user).**
As the office manager, I juggle the front desk, reminders, reschedules, and
a voicemail backlog while patients stand in front of me. I want the routine
phone/text/paperwork volume handled automatically, with a simple inbox of
"things that need a human," so my day is patients, not phone tag.

**Jess, the patient (the end beneficiary).**
As a patient, I remember at 9pm that my tooth hurts. I want to call, get a
warm answer, and walk away booked for tomorrow — not leave a voicemail and
call three other clinics in the morning.

**The insurance reality (the expansion buyer).**
As the owner, late and mis-coded claims mean denials and 60-day cash
delays. I want audit-ready notes and drafted claims every morning — but I
sign off on every one, because it's my license. *(This is the wedge into
revenue cycle — the essay's $50–80B column.)*

**Jay, Sailz founder (the HQ story).**
As a solo founder, every new client must cost near-zero marginal labor:
onboarding by wizard, monitoring by heartbeat, reporting by agent — so I
can run 50 brains alone, and the metrics dashboard IS the VC pitch.

## Is everything we're building required?

Test each piece against the stories above:

| Built/building | Required? | Which story it serves |
|---|---|---|
| Receptionist + booking + calendar | Core | Dr. Shah, Jess |
| SMS/email confirmations + reminders | Core (no-show killer) | Dr. Shah, Maria, Jess |
| Calls tab with recordings | Core (trust + proof) | Dr. Shah, Maria |
| Attention inbox + notifications | Core (Maria's "human queue") | Maria |
| Audit + billing agents w/ approval gate | Core (the expansion wedge) | Insurance story |
| Memory/librarian + Vapi sync | Core (the data moat) | All — it's the compounding |
| Chat with the brain | High value, not core | Dr. Shah convenience |
| Brain map UI | Sales asset — required for *distribution*, not for the outcome | Jay (closes deals) |
| Weekly report email | Retention insurance | Dr. Shah |
| Sailz HQ brain | Required at ~5 clients, not before | Jay |
| Video live sales agent, full autonomy, etc. | Not now — founder sells better than an avatar in 2026 | — |

Verdict: nothing we've built is decoration, and the discipline to keep the
"not now" column not-now is what keeps us shipping.

## The "AI runs the whole company" question

The pattern making noise (e.g. solo founders running agent-augmented
operations to $1M ARR) is real — but read closely, the winners are
founders acting as **orchestrators of an AI workforce with themselves as
the judgement layer**, not absentee owners of autonomous AIs. That is
precisely our architecture: agents do 99% of the motion, one human approves
the 1% that is spend, speech, and claims. The essay says it in one line:
AI does the intelligence, humans keep the judgement — *for now* — and the
companies that log that judgement as data own the convergence.

## The solution, in one paragraph

Keep going exactly as scoped, in order: Shine runs flawlessly (proof) →
confirmations/inbox/chat ship (retention) → memory compounds (moat) → 5
dental clients via the answering-service vendor-swap pitch (distribution) →
HQ brain + onboarding wizard (scale) → dental revenue-cycle autopilot
(the $50–80B expansion). The brain map is the brand; the approval gate is
the trust; the memory is the moat; the founder is the judgement.
