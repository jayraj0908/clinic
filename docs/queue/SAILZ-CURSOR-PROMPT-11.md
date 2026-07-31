# Prompt for Cursor / Claude Code — Mobile-First Pass (the owner's surface is their phone)

Can run before or after PROMPT-10 (independent). Copy below the line.

---

You are working on **Sailz** (this repo). The client is a restaurant/
car-wash/clinic OWNER — they live on their phone, standing up, between
customers. Read first: `public/index.html` (the app), CLIENT-DASHBOARD-
PLAN.md "rules to keep it from getting clunky".

## Mission

Every surface a client touches works beautifully one-handed on a phone:
map, orders, calls, leads, calendar, agent panels, bell, onboarding
wizard. Plus installable as a home-screen app.

## Hard constraints

1. No desktop regression — every change verified at 1280×800 AND 390×844.
2. No new frameworks. Same design system.
3. Small commits per stage; Playwright screenshots at both viewports for
   every stage as verification artifacts.

## Stage 1 — Audit + navigation

- Audit all tabs at 390×844; list findings in MOBILE-AUDIT.md first.
- ≤640px: top nav collapses to a bottom tab bar (thumb-reach), 44px+
  touch targets everywhere, bell + signout stay top-right.

## Stage 2 — Map on touch

- Pinch zoom + one-finger pan (Pixi pointer events; no page scroll
  fights), tap targets ≥40px effective radius on hubs/nodes, agent
  panel opens as full-screen sheet on mobile (slide up, swipe-down to
  close), chevrons remain for department stepping.

## Stage 3 — Work surfaces

- Orders/Calls/Leads/Calendar at 390w: single-column cards, status
  advance as big thumb buttons, drawers become full-screen sheets,
  audio player usable, calendar defaults to agenda view on mobile.
- Onboarding wizard re-audit on phone (it was built mobile-first —
  verify, fix drift).

## Stage 4 — Installable

- manifest.json (name from instance settings, brandColor theme, icon —
  generate a simple sailboat glyph icon), apple-touch-icon, service
  worker for shell caching ONLY (never cache /api/*), "Add to Home
  Screen" works on iOS + Android. Owner taps the icon → straight to
  their live dashboard.

## Stage 5 — Verification

Playwright at 390×844 + 1280×800: screenshot every tab both sizes;
tap-through: open agent panel, advance an order, queue a callback, all
via touch events; Lighthouse mobile score ≥85 on /; manifest validates;
service worker never serves stale API data (verify fresh /api/dashboard
after a change). Full prior regression at desktop size.
