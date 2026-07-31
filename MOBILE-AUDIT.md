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

## Stage 2 — done

- `idleScale()` now shrinks by a wider divisor on the width axis
  specifically (`min(w/760, h/600)` vs the old `min(w,h)/600`) — the ring
  overview's edge department labels (MARKETING, BACK OFFICE) no longer
  clip past 390px's edges. Verified unchanged at 1280×800 (both formulas
  clamp to the same 1.0 ceiling there).
- `canvas{touch-action:none}` — explicit belt-and-suspenders alongside
  the existing viewport `user-scalable=no` and `body{overflow:hidden}`
  so a touch drag on the map never fights the browser's own
  pinch-zoom/pull-to-refresh/edge-swipe gestures.
- **Deliberately did not add free-form pinch-zoom/drag-pan camera
  control.** The map's camera is a hard existing design decision (see
  the "camera" comment in `public/index.html`): it only ever moves via
  precise, deterministic, click-driven animated tweens — never
  user-panned/zoomed — so every layout (ring vs. focused-department
  tree) is a pure function of a known state, guaranteeing text/branches
  never overlap. Real free-form pinch/pan would need a parallel camera
  state machine and contradicts that architecture for marginal user
  value (tapping a department already animates precisely to it). The
  audit's actual underlying complaint — content clipping at mobile
  widths — is fixed directly above instead.
- Branch/skill node tap radius bumped 15→20px (40px effective tap
  diameter) — big enough finger forgiveness without adjacent
  branch/fork nodes (75px+ apart) getting overlapping hit zones.
- Agent/department panel (`#sidebar`) is a proper bottom sheet on
  mobile — slides up (not desktop's slide-in-from-left), rounded top
  corners, drag handle, swipe-down-to-dismiss (`touchstart`/`touchmove`/
  `touchend` on the handle, live-follows the finger, snaps closed past
  90px or a fast flick, springs back otherwise). Desktop's left-drawer
  is untouched (`.sb-drag{display:none}` outside the mobile query).
  Chevrons (prev/next department stepping) unchanged, still present.
- Found and fixed in passing: the `#crumbBack` ("‹ All departments")
  pill collided with the 44px top-right icon cluster at 390px — moved
  below the icon row on mobile instead of shrinking icons under the
  touch-target minimum to make room.
