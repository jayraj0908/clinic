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

## Stage 3 — done

- **Calls table** → single-column labeled cards at ≤640px (CSS-only:
  `data-label` attributes added to each `<td>` in `renderCalls()`, a
  media query turns the table into stacked blocky rows with
  `content:attr(data-label)` mini-headers). Desktop table layout is
  untouched — verified identical at 1280×800.
- **Order status advance** → full-width 46px-tall button on mobile
  (`.oc-advance{flex-basis:100%}` inside the media query only); desktop
  keeps the compact inline button.
- **All three right-slide drawers** (`#callDrawer`, `#memoryDrawer`,
  joining `#chatDrawer` which already had this) → full-screen (100vw) on
  mobile, so call/order/event detail and memory review are reachable
  one-handed instead of a fixed side panel. The call drawer's `<audio>`
  player was already `width:100%` — confirmed it just inherits the
  drawer's new full width, no separate change needed.
- **Calendar** — re-examined against real (Google Calendar-backed) data
  at 390px: the existing `max-width:820px` day-stacking breakpoint
  already reads as a genuine agenda list (date header → events →
  "No bookings." for empty days, one clean scroll), not 7 cramped
  columns. No code change needed — the Stage 1 audit undersold this as
  "not yet a true agenda view"; verified it functionally already is one.
- **Onboarding wizard** re-audited on phone (real token, `/onboard/:token`
  at 390×844): no drift found — single-column form, thumb-sized
  "Continue" button, progress dots all render cleanly as-is. Confirms
  the "built mobile-first" claim; no changes made.

## Stage 4 — done (installable)

- `GET /manifest.json` (new route, `server/server.js`) — generated
  per-request from `db.settings.clinicName || instance.name` and
  `instance.brandColor`, not a static file, so each deployment's install
  prompt/home-screen name and theme color reflect ITS actual clinic, not
  a hardcoded default. Verified: swapping in a clean instance (no
  `db.settings.clinicName` set) correctly falls back to `instance.name`
  ("The Burg — Sailz", `#e05545`) — the one test run that showed "Shine
  Dental Clinic" was a local-only artifact (this machine's shared `.env`
  has `CLINIC_NAME` hardcoded, which every local seed picks up
  regardless of `INSTANCE`; Railway services don't share env vars across
  deployments, so this doesn't happen in production).
- Icons: a plain sailboat glyph (⛵) rendered onto a dark rounded
  background, exported at 192/512/512-maskable + a 180×180
  `apple-touch-icon.png` + 32×32 favicon (`public/icons/`,
  `public/apple-touch-icon.png`, `public/favicon-32.png`). Shared static
  assets across every instance — the spec asked for one simple icon, not
  a per-instance-colored set (that's what the manifest's dynamic
  `theme_color` already covers).
- `<head>` gained the manifest link, apple-touch-icon link, favicon,
  `theme-color` meta, and the `apple-mobile-web-app-*` meta trio iOS
  needs for standalone/status-bar behavior when added to the home
  screen.
- `public/sw.js` (new): shell-only service worker. Never intercepts
  `/api/*` or any cross-origin request (Google Fonts, the PixiJS CDN
  script) — those fall straight through to the network untouched.
  Same-origin shell requests (`/`, manifest, icons) are network-first
  with a cache fallback, so a deploy is visible immediately while
  online and the cache only ever covers an offline fallback. Registered
  from `index.html` on `window.load`.
- Verified live: service worker registers and reaches `active` state
  with zero console errors; mutated real order data via `/api/orders/
  :id/advance` and re-fetched `/api/orders` through the same active
  service worker with no reload — status flipped `new` → `preparing`
  immediately, confirming the SW never serves stale `/api/*` data.
  Desktop (1280×800) unaffected.
- Lighthouse (mobile, `npx lighthouse`, headless) on `/`: **performance
  99, best-practices 96, accessibility 79** — comfortably clears the ≥85
  bar on performance. The two accessibility deductions are both
  pre-existing design decisions, not regressions from this pass, and
  weren't changed:
  - `color-contrast` — the app's whole dark/dim-text aesthetic
    (established across every prior stage of this project); redesigning
    the color system is out of scope for a mobile-navigation pass.
  - `meta-viewport` (`user-scalable=no`) — was already in `index.html`
    before Stage 1. Deliberately left as-is: it's what makes Stage 2's
    "no page scroll fights" guarantee possible (alongside
    `touch-action:none`) for the Pixi map's click-only camera: without
    it, a touch drag risks the browser's own pinch-zoom fighting the
    canvas instead of the map's own deterministic navigation. Flagging
    the tradeoff here rather than silently overriding an existing,
    intentional decision.
