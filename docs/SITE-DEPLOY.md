# Deploying sailz.org from Sailz HQ

The marketing site is served by the **existing HQ Railway service**. No
second service, no Cloudflare Pages project, no separate repo. `sailz.org`
and `hq.sailz.org` are the same deployment, routed by Host header in
`server/siteHost.js`.

| Host | Serves |
|---|---|
| `sailz.org`, `www.sailz.org` | `site/` (the marketing site) |
| `hq.sailz.org` | `public/` (the HQ dashboard, unchanged) |
| any host, `/site/` | `site/` (preview, works before DNS exists) |

Client services (`shine`, `theburg`, `rprg`) ship the same code and are
completely unaffected: without `SAILZ_ADMIN=1` the whole module never
mounts. Verified, not assumed.

---

## Status: everything below is DONE except step 1

Completed 5 August, driving Railway and Cloudflare directly:

- `SITE_ENABLED=1` and `SITE_HOSTS=sailz.org,www.sailz.org` on the
  **sailz-hq** service. Redeployed, successful, Online.
- `sailz.org` added as a Railway custom domain on sailz-hq, port 8080.
- Cloudflare: `sailz.org` CNAME to `tw8b7gzw.up.railway.app`, **DNS only**,
  plus the `_railway-verify` TXT record. Railway verified it and HTTPS
  works.
- `www.sailz.org` CNAME to `sailz.org`, **Proxied**, plus a Redirect Rule
  (301, query string preserved) sending www to the apex. Verified live:
  `https://www.sailz.org` returns 301 to `https://sailz.org/`.

**Two things that came up and how they were handled:**

1. **Railway's Hobby plan custom-domain limit was already reached.** So
   `www.sailz.org` could not be added as a second Railway domain. It is
   handled entirely at Cloudflare with the redirect rule above, which
   costs nothing and is the better setup anyway. No plan upgrade needed.
2. **The apex is DNS-only while every client subdomain is proxied.** That
   was deliberate: proxying the apex during Railway's initial verification
   is exactly what caused the multi-day `rprg.sailz.org` stall. Now that
   it is verified you *may* switch it to proxied to match the others, with
   SSL/TLS set to Full (strict). It works fine as it is.

## 1. Push the code (the only remaining step)

```bash
node scripts/build-site-data.mjs        # regenerate site/data.js
git add site server/siteHost.js server/server.js scripts brain docs STATUS.md
git commit -m "Serve sailz.org from HQ"
git push
```

Until this lands, `sailz.org` serves the HQ dashboard login. The moment it
deploys, the host router in `server/siteHost.js` takes over and the apex
serves the marketing site.

**One warning.** All four services auto-deploy from `main`, so this push
redeploys shine, theburg and rprg as well. The changes are inert for them
(verified against a running shine-dental deployment: `/site` 404s,
`/api/site/lead` 404s, the dashboard is untouched), but it is still a
redeploy of live client services. Push at a quiet hour if you would
rather.

Also note `rprg` is currently **offline and has no volume attached**. That
is a separate, unresolved problem and the reason that client's imported
leads vanished.

## 2. Verify after the push

```
https://sailz.org            -> the marketing site
https://www.sailz.org        -> the marketing site
https://hq.sailz.org         -> your dashboard login, unchanged
https://hq.sailz.org/site/   -> the marketing site (preview path)
https://shine.sailz.org      -> unchanged
```

Then run the booking chat through to the end on the live domain and
confirm the lead appears in HQ's Leads tab with source `website`.

---

## What the lead endpoint does

`POST /api/site/lead`, HQ only, unauthenticated because it is a public
contact form. Guards: 6 per hour per IP, required name/business/email,
email format check, a honeypot field that answers 200 so bots do not
retry, control characters stripped, every field length capped.

**It never writes `consentBasis`.** Filling in a web form is not consent
to be cold-called by an AI voice, and the dialer reads `consentBasis` to
decide what it may dial. Website leads are yours to call back, or to
email. That is deliberate and should stay that way.

## What HQ can and cannot do with the site today

It **serves** the site, so the site is inside HQ's world: same deploy,
same database, same-origin lead capture, and it ships in the same commit
as the product change it describes.

It cannot yet **edit** the site. Asking your HQ brain to change a
headline needs an agent that can write a file and open a commit, which
neither prompt 18 nor 20 gives it. That is a real gap, not a detail, and
it is written into prompt 20 as stage 7 so it does not get lost. Until
then, site changes are a Cursor job like any other.

## Cost

Nothing new. Same Railway service, same plan. The site is static files
served by an Express process that was already running.
