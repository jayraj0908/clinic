# Mobile audit — 390×844 (iPhone-class viewport)

Audited every tab (`public/index.html`) at 390×844 against a live local
server (The Burg instance, real owner session), via Playwright screenshots.
Findings below drive the mobile-first pass (docs/queue/SAILZ-CURSOR-PROMPT-11.md).

## Stage 1 (this pass) — navigation

1. **Top tab bar overflows the viewport.** `.tabs` (MAP / DASHBOARDS /
   CALLS / CALENDAR / ORDERS / CHART) is a fixed-width center-anchored
   pill row sized for desktop — at 390px the last tab (CHART) is cut off
   past the right edge with no scroll affordance. Not discoverable, not
   tappable.
2. **Top-right icon cluster (theme/memory/chat/bell/signout) is 34×34px.**
   Below the 44px touch-target minimum; tight gaps between them risk
   mis-taps.
3. **`#bottombar` (the map's department-stepping ‹ › carets) has no
   view-scoping — it's `position:fixed` and rendered on every tab, not
   just Map.** Confirmed floating on top of real content on Dashboards,
   Calls, Calendar, Orders, and Workforce (Chart) — e.g. it visibly
   overlaps the last Workforce card's title. This is a latent bug at
   desktop width too (just less noticeable there since the carets sit in
   empty space under short desktop content); mobile's shorter effective
   viewport height makes it collide with real content directly.
4. **No bottom tab bar exists at all today** — everything currently
   routes through the cramped top pill row from finding #1.

## Confirmed OK as-is (no Stage-1 change needed)

- Dashboards KPI cards (`.cards{grid-template-columns:repeat(auto-fit,
  minmax(220px,1fr))}`) already collapse to a clean single column at
  390px — no changes needed here.
- Workforce/catalog cards (`.wgrid`, `minmax(280px,1fr)`) likewise
  already collapse to single column and read fine.
- Orders' filter-pill row wraps acceptably at 390px.
- Calendar's 7-day grid already has a `max-width:820px` breakpoint that
  stacks days as blocks instead of 7 cramped columns — confirmed
  rendering correctly with real (Google Calendar-backed) event data once
  given enough load time. Not yet a true "agenda" view — tracked for
  Stage 3 per spec, not a Stage-1 blocker.

## Deferred to later stages (explicitly out of scope for Stage 1)

- **Map ring overview clips at the edges** at 390px — department names
  (MARKETING, BACK OFFICE) run past the left/right viewport edges.
  `idleScale()` only scales by raw ring radius, not rendered text width.
  → Stage 2 (map on touch).
- **Calls table** (`.calls-table{min-width:640px}`) forces horizontal
  scroll on mobile instead of stacking as cards. → Stage 3 (work
  surfaces).
- Calendar as a true agenda/list view (not just a stacked week grid).
  → Stage 3.
- Onboarding wizard re-audit on phone. → Stage 3.
- Installability (manifest/service worker). → Stage 4.

## Stage 1 fix plan

- `#bottombar` only renders on `view==='map'` (fixes finding #3 at every
  viewport width, not just mobile).
- `.tabs` becomes the mobile bottom tab bar via a `max-width:640px`
  media query (repositioned, not duplicated — same buttons, same click
  wiring, CSS-only relayout): fixed to the bottom, full width, evenly
  spaced, ≥50px-tall tap targets, safe-area-inset-bottom padding for the
  iOS home indicator.
- Top-right icon buttons bumped to 44×44px at ≤640px.
- `#bottombar` (carets, map-only) and `.brand` repositioned above the
  new bottom tab bar on mobile so nothing stacks on top of it.
