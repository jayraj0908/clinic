// Serves the public marketing site (site/) from the Sailz HQ deployment,
// routed by Host header, plus the endpoint the site's booking chat posts
// to.
//
// Why this lives on HQ rather than on a separate static host: the site is
// part of the business HQ runs, not a separate property. Same repo, same
// deploy, same database. When HQ's agents can edit files (prompt 20), the
// site is inside their reach, the lead endpoint is same-origin so there is
// no CORS to configure, and a website change ships in the same commit as
// the product change it describes.
//
// Routing:
//   sailz.org, www.sailz.org  -> site/     (the marketing site)
//   hq.sailz.org              -> public/   (the HQ dashboard, unchanged)
//   any host, path /site/*    -> site/     (preview before DNS exists)
//
// Everything is gated on SAILZ_ADMIN=1 plus SITE_ENABLED=1, so this file
// is inert on every client deployment even though they all ship the same
// codebase.
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { load, save, log } = require("./store");
const notify = require("./notify");

const SITE_DIR = path.join(__dirname, "..", "site");

function parseHosts(raw) {
  return String(raw || "sailz.org,www.sailz.org")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

// Host headers arrive with a port attached on some setups ("sailz.org:443")
// and with arbitrary casing. Normalise both before comparing.
function hostOf(req) {
  return String((req && req.headers && req.headers.host) || "").toLowerCase().split(":")[0];
}

function looksLikeEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

// Strip control characters (including the newlines that would let someone
// inject extra headers into the notification email), then trim and cap.
function clean(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function ownerEmailFrom(db) {
  if (process.env.OWNER_EMAIL) return process.env.OWNER_EMAIL;
  const owner = (db.users || []).find((u) => u.role === "owner");
  return owner ? owner.email : null;
}

/**
 * @param {import('express').Express} app
 * @param {{enabled:boolean}} opts  `enabled` must already fold in SAILZ_ADMIN
 * @returns {{mounted:boolean, hosts:string[]}}
 */
function mount(app, opts) {
  if (!opts || !opts.enabled) return { mounted: false, hosts: [] };

  const hosts = parseHosts(process.env.SITE_HOSTS);
  const staticOpts = {
    // index.html is served explicitly below, so both the bare domain and an
    // unmatched path resolve to it.
    index: false,
    setHeaders(res, filePath) {
      // data.js is regenerated on every deploy. A long cache there would
      // show a visitor an agent roster we no longer ship.
      if (/\.(png|ico|woff2?)$/.test(filePath)) res.setHeader("Cache-Control", "public, max-age=604800");
      else res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    },
  };

  // Preview path, available on any host. Lets the site be checked on
  // hq.sailz.org before the apex DNS points anywhere.
  app.use("/site", express.static(SITE_DIR, staticOpts));
  app.get("/site", (req, res) => res.sendFile(path.join(SITE_DIR, "index.html")));

  // Host-routed serving. Registered BEFORE express.static(public), so on a
  // marketing host the site wins; on any other host this is a no-op and the
  // dashboard behaves exactly as it did.
  const siteStatic = express.static(SITE_DIR, staticOpts);
  app.use((req, res, next) => {
    if (!hosts.includes(hostOf(req))) return next();
    // API and webhook traffic is never shadowed by a static file, whatever
    // the host. A marketing domain that swallowed /webhooks/vapi would be an
    // outage that looks like a caching bug.
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/")) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    siteStatic(req, res, () => {
      // Unmatched path on a marketing host: serve the site's index rather
      // than falling through to the dashboard's login screen, which would be
      // a confusing thing for a prospect to land on.
      res.sendFile(path.join(SITE_DIR, "index.html"), (err) => {
        if (err) next();
      });
    });
  });

  /* ----------------------------- lead intake ---------------------------- */
  // The booking chat posts here. Deliberately unauthenticated, because it is
  // a public contact form, so every guard sits on this route rather than
  // behind a login.
  const leadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many enquiries from this address. Email hello@sailz.org instead." },
  });

  app.post("/api/site/lead", leadLimiter, async (req, res) => {
    const b = req.body || {};

    // Honeypot: a field no human sees and every naive bot fills. Answer 200
    // so the bot believes it succeeded and does not retry with variations.
    if (clean(b.company_website, 200)) return res.json({ ok: true });

    const name = clean(b.name, 80);
    const business = clean(b.business, 120);
    const email = clean(b.email, 160);
    if (!name || !business || !email) {
      return res.status(400).json({ error: "Name, business and email are required." });
    }
    if (!looksLikeEmail(email)) {
      return res.status(400).json({ error: "That email does not look valid." });
    }

    const lead = {
      id: "L" + Date.now(),
      name,
      phone: clean(b.phone, 40),
      email,
      source: "website",
      service: clean(b.vertical, 60),
      status: "new",
      createdAt: new Date().toISOString(),
      // No consentBasis is written here, on purpose. Submitting a web form
      // is not consent to be cold-called by an AI voice, and the dialer
      // reads consentBasis to decide what it may dial. Jay calls these back
      // himself, or they get an email.
      website: {
        business,
        vertical: clean(b.vertical, 60),
        volume: clean(b.volume, 60),
        plan: clean(b.plan, 40),
        planInterest: clean(b.planInterest, 40),
        message: clean(b.message, 2000),
        userAgent: clean(req.headers["user-agent"], 200),
      },
    };

    const db = load();
    db.leads.unshift(lead);
    save();
    log("lead", `Website enquiry from ${business} (${name})`);

    // Best effort. A failed notification must never lose the lead, which is
    // already saved above.
    try {
      const to = ownerEmailFrom(db);
      if (to && notify.hasResend()) {
        const w = lead.website;
        const html = [
          `<p><strong>${escapeHtml(name)}</strong> at <strong>${escapeHtml(business)}</strong></p>`,
          `<p>${escapeHtml(email)}${lead.phone ? " &middot; " + escapeHtml(lead.phone) : ""}</p>`,
          "<ul>",
          `<li>Vertical: ${escapeHtml(w.vertical || "not given")}</li>`,
          `<li>Call volume: ${escapeHtml(w.volume || "not given")}</li>`,
          `<li>Likely plan: ${escapeHtml(w.plan || "to discuss")}</li>`,
          "</ul>",
          `<p>${escapeHtml(w.message || "(no message)")}</p>`,
        ].join("");
        await notify.sendEmail(to, `Sailz enquiry: ${business}`, html);
      }
    } catch (e) {
      log("system", "Website lead saved but the notification email failed: " + (e && e.message));
    }

    res.json({ ok: true });
  });

  return { mounted: true, hosts };
}

module.exports = { mount, parseHosts, hostOf, clean, looksLikeEmail };
