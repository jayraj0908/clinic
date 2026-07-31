# The Burg — Demo Call Runbook

## Before you book the demo (do these first — they make or break it)

1. **Load their REAL menu.** The demo lands 10× harder when he orders off
   his own menu. Pull it from their website/Google/a menu photo (20 min):
   - update `instances/the-burg/clinic-profile.json` services → push →
     Railway redeploys
   - update the Menu section of the Vapi system prompt to match
   No real menu yet → do the 10-min discovery call first. Do not demo
   placeholder burgers to a man who owns a menu.
2. **Kitchen email:** set `KITCHEN_EMAIL` in Railway to YOUR email for the
   demo (you'll show the ticket landing live). His kitchen's address goes
   in at go-live.
3. **DEMO_MODE=1** confirmed in env.
4. **Five test calls the night before** off the real menu, including one
   allergy and one off-menu item. Fix any fumble in the Vapi prompt.

## 30 minutes before

- POST /api/demo/reset (owner login) — clean slate
- Laptop: logged into the-burg dashboard, Orders tab open, brain map in
  a second tab. Phone charged. One final test call → reset again.

## The demo (15 minutes, in this order)

**1. The pain (2 min).** "Friday rush, three lines going, phone rings —
what happens?" Let HIM say the answer. Then: "every missed call is a
$25–40 order walking to the shop next door."

**2. The moment (5 min).** Slide him the number: "Call it. Order
whatever you want. Argue about toppings." While he's on the phone,
turn the laptop toward him:
- his order materializes on the Orders tab as he speaks
- the itemized total computed, pickup time set
- the kitchen ticket lands in email — allergy line if he mentioned one
Say nothing during this. The silence sells.

**3. The brain (4 min).** Brain map tab: his Order Line node with the
call in its activity. One line: "every agent in your business will live
on this map — this is just the first one we switched on." (If the
catalog build has shipped: show the dormant agents — "these are waiting
whenever you want them.")

**4. It learns (2 min).** Show the unanswered-question → proposed-fact
flow from your test call: "you approve what it learns — it gets smarter
about YOUR shop every week, and you're always in charge of what it says."

**5. Honesty (1 min).** Three things, unprompted — this is what makes
you credible: SMS confirmations switch on when carrier registration
clears (days away); direct SkyTab injection is phase 2 (kitchen ticket +
15-second quick-sale until then); week one will fumble a weird modifier
or two — that's what the learning loop is for, and you review every
call in the early weeks.

**6. Close (1 min).** Price from the brief (setup $1,000–1,500 +
$297–497/mo). Then: "If this felt right, your real line can be
forwarding to it by Friday — and forwarding turns off from your phone in
30 seconds any day you want. Zero lock-in." Ask for the yes.

## Objections, pre-answered

- "What if it gets an order wrong?" → It reads every order back before
  placing it; if anything fails it takes a callback number instead of
  faking success; you'll hear the recordings.
- "Friday rush volume?" → It answers every call simultaneously. No busy
  signal, no hold. That's the one thing a human counter person can't do.
- "Can I turn it off?" → Forwarding off from your phone, 30 seconds.
- "Why not just hire someone?" → $38–52k/year for the seat, and they
  still can't take three calls at once at 8pm.

## After the yes
Owner signs → go-live steps in DEPLOY-CHECKLIST.md (real kitchen email,
DEMO_MODE off, demo reset, owner login handed over, forwarding on,
first-week watch).
