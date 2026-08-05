# Sailz — sailz.org

Static. No build step, no framework, no bundler. Five files plus one
generated data file.

```
site/
  index.html    structure and copy
  styles.css    the design system, lifted from the product's own palette
  map.js        the brain constellation (PixiJS), ported from the dashboard
  app.js        scroll, reveals, the call demo, the booking conversation
  data.js       GENERATED, do not edit
  privacy.html  terms.html
  favicon-32.png  apple-touch-icon.png
```

## The one rule

`data.js` is generated from the product itself:

```bash
node scripts/build-site-data.mjs
```

It reads `brain/agents/*.md` (what each agent is, its colour, glyph and
workflow bullets) and `brain/blueprints/*.json` (which agents a vertical
gets, which one is the hero, which dashboard tabs exist). Regenerate it
whenever an agent or blueprint changes. The site's whole claim is "this
is the actual thing you get", and hand-editing `data.js` breaks that.

The generator exits non-zero if a blueprint names an agent that does not
exist, so a broken map fails the build instead of shipping a hole.

## What is real here, and what is illustrative

Real, and generated from the codebase: every agent name, colour, glyph,
description and workflow list; which agents each vertical gets; which
dashboard tabs each vertical has.

Written by hand, and honest but illustrative: the ticker strip, the two
call transcripts in "See it work", and the numbers on the three dashboard
screens. They describe how the product behaves. They are not a specific
client's data, and no client is named anywhere on the site.

## The map

`map.js` is a port of the PixiJS constellation in `public/index.html`:
the same seeded starfield, core dust cluster, glow hubs, curved edges
with travelling pulses, and the camera tween that focuses a hub and
expands its workflows as leaves.

Two modes. `ambient:true` drifts behind the hero with no interaction.
`ambient:false` is the interactive one in the brain section. Both pause
when scrolled off screen, so there is never a WebGL context burning
frames nobody can see.

If WebGL is unavailable the module returns `null` and the page falls back
to the DOM node list, which carries exactly the same information as real
buttons. A prospect on a locked-down work laptop must never see a black
rectangle.

**When prompt 20 stage 3 lands**, the dashboard's map becomes
`public/js/brain-map.js` and this file should be replaced by an import of
it. Until then the two are deliberate siblings, and a change to the
dashboard map needs mirroring here.

## The booking conversation

`app.js` runs a scripted seven-step intake: vertical, problem, call
volume, business, name, email, phone. It validates the email, recommends
a plan honestly from the volume answer (it will say Solo when Solo is
right), switches the brain map above to the visitor's industry as they
answer, and ends with a structured summary.

It is entirely client side today, so it works on a static deploy with no
API key and no per-conversation cost. It posts to
`window.SAILZ_LEAD_ENDPOINT` when that is defined and falls back to the
visitor's mail client otherwise, so the form is never a dead end.

To point it at HQ once the endpoint exists, add before `data.js`:

```html
<script>window.SAILZ_LEAD_ENDPOINT = "https://hq.sailz.org/api/site/lead";</script>
```

Prompt 20 stage 4 replaces the script with a Haiku conversation behind
the same interface. Nothing the visitor sees has to change.

## Deploying

**It ships with the HQ Railway service.** Not Cloudflare Pages, not a
separate repo. `server/siteHost.js` routes by Host header:

| Host | Serves |
|---|---|
| `sailz.org`, `www.sailz.org` | this folder |
| `hq.sailz.org` | the HQ dashboard, unchanged |
| any host, `/site/` | this folder (preview before DNS exists) |

Two env vars on the hq service, `SITE_ENABLED=1` and
`SITE_HOSTS=sailz.org,www.sailz.org`, then Railway custom domains and two
grey-cloud CNAMEs in Cloudflare. Full runbook with the exact steps and the
proxy gotcha: `docs/SITE-DEPLOY.md`.

Client services ship this same code and never mount any of it. Verified
against a running shine-dental deployment, not assumed.

## The lead endpoint

`POST /api/site/lead`, HQ only. Rate limited to 6 an hour per IP, required
name, business and email, format checked, honeypot that answers 200 so
bots do not retry, control characters stripped, every field capped.

It deliberately never writes `consentBasis`. Filling in a web form is not
consent to be cold-called by an AI voice, and the dialer reads that field
to decide what it may dial.

## Before this goes live

- [ ] `hello@sailz.org` and `privacy@sailz.org` need to actually deliver.
- [ ] Read `privacy.html` and `terms.html` end to end. They are written to
      be accurate about how Sailz behaves, but no lawyer has reviewed them.
- [ ] Check the retention periods in `privacy.html` (12 months for call
      recordings) match what the deployments actually do.
- [ ] Naming a client on the site needs their written permission first.
