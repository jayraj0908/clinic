require("dotenv").config();
const fs = require("fs");
const zlib = require("zlib");
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const cron = require("node-cron");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { load, save, log, DB_PATH } = require("./store");
const { runAgent, isSameFact } = require("./agents");
const calendarApi = require("./calendar");
const brainGraph = require("./brainGraph");
const notify = require("./notify");
const chat = require("./chat");
const { maskPhone, verifyMetaSignature } = require("./security");
const vapiSync = require("./vapiSync");
const vapiAssistant = require("./vapiAssistant");
const heartbeat = require("./heartbeat");
const hqClients = require("./hqClients");
const rfp = require("./rfp");
const leadQueue = require("./leadQueue");
const { instance, profile } = require("./instance");
const orders = require("./orders");
const onboarding = require("./onboarding");
const ingest = require("./ingest");
const { diffProfileFragment, applyProfileEdit } = require("./profileEdits");
const multer = require("multer");
const catalog = require("./catalog");
const { AGENTS } = require("./brain");

const NODE_ENV = process.env.NODE_ENV || "development";

// HQ admin gate — Sailz's own provisioning/onboarding console (who gets
// onboarded, draft review, activation) must never exist on a client
// deployment, not even behind a login. Set SAILZ_ADMIN=1 only on Sailz's
// own internal instance (instances/sailz-hq); Shine, The Burg, and every
// other client deployment simply never set it, so these surfaces 404 —
// indistinguishable from a route that was never registered — regardless
// of who's asking or whether they have a valid owner token. The
// client-facing wizard (/onboard/:token and its step/complete routes) is
// deliberately NOT gated here: a token is only ever minted by HQ's own
// /api/onboarding/create, so it stays meaningless on a client instance's
// own (separate) database with or without this flag.
const SAILZ_ADMIN = process.env.SAILZ_ADMIN === "1" || process.env.SAILZ_ADMIN === "true";

// Vapi assistant-request: composes the assistant config fresh from this
// repo (server/vapiAssistant.js) instead of Vapi using its own
// dashboard-pasted copy. Off by default on every deployment — flip per
// service only after the operator steps in vapiAssistant.js's file header
// are done. The dashboard assistant stays attached as Vapi's own fallback
// the whole time; this flag never removes or requires removing it.
const VAPI_ASSISTANT_REQUEST = process.env.VAPI_ASSISTANT_REQUEST === "1" || process.env.VAPI_ASSISTANT_REQUEST === "true";
function requireHQ(req, res, next) {
  if (!SAILZ_ADMIN) return res.status(404).end();
  next();
}

// First boot (e.g. a fresh Railway deploy with no persistent volume yet):
// seed so the owner login exists. Skipped whenever a database already
// exists, so a restart/redeploy never wipes real accumulated data.
if (!fs.existsSync(DB_PATH)) {
  console.log("No database found — running first-time seed...");
  require("./seed");
}

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy — needed for express-rate-limit to see the real client IP

// helmet with a CSP compatible with brain.html's design system: inline
// <script type="module">/<style> blocks (this app has no build step, so
// there's no nonce/bundle to switch to), PixiJS from cdnjs, Google Fonts,
// and audio playback from wherever Vapi hosts call recordings (unknown
// domain in advance, hence the broad https: allowance on media-src only).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-eval' is required by PixiJS 7's WebGL renderer itself
        // (shader/geometry program compilation) — confirmed by testing:
        // without it, PixiJS throws "does not allow unsafe-eval" and the
        // brain map never renders at all. This is PixiJS's own documented
        // limitation (they ship a separate @pixi/unsafe-eval module to work
        // around it, out of scope for this pass).
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
        // helmet defaults script-src-attr/style-src-attr to 'none'
        // regardless of script-src/style-src — a SEPARATE directive
        // specifically for inline event-handler attributes (onclick="...")
        // and inline style="..." attributes, both used throughout this
        // app's no-build-step HTML. Without these, the login button (and
        // every style="color:${col}"-style dynamic color) silently stops
        // working under CSP.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", "https:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
// verify captures the raw request body bytes onto req.rawBody — needed to
// check Meta's X-Hub-Signature-256 HMAC, which is computed over the exact
// bytes Meta sent, not a re-serialization of the parsed JSON.
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
// public/brain.html is the earlier WebGL brain-map prototype — index.html
// replaced it as the primary UI. Redirect rather than 404/serve-stale, so
// anyone with the old URL bookmarked lands on the real product instead of
// a frozen old screen. Registered before the static middleware so it wins
// over the file that's still sitting in public/ for reference.
app.get("/brain.html", (req, res) => res.redirect(301, "/"));
// Sailz's own provisioning console — 404 on every deployment except HQ's
// own (SAILZ_ADMIN=1), same reasoning as requireHQ below. Registered
// before the static middleware so it wins over the file that's still
// sitting in public/ (every deployment ships the same codebase).
// onboarding-review.html was the whole console before Stage 4 folded it
// into admin.html as one tab (CLIENTS being the other) — redirect old
// bookmarks/links rather than 404 or serve a frozen standalone page.
// Same 404-if-not-HQ gate either way, so a redirect never leaks that this
// deployment IS the HQ instance to a client that can't reach either URL.
app.get("/onboarding-review.html", (req, res) => {
  if (!SAILZ_ADMIN) return res.status(404).end();
  res.redirect(301, "/admin.html?tab=onboarding");
});
app.get("/admin.html", (req, res) => {
  if (!SAILZ_ADMIN) return res.status(404).end();
  res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
});
// PWA manifest — generated per-request (not a static file) so name/theme
// color reflect THIS deployment's actual instance/owner-set clinic name,
// not a hardcoded default. Icons are shared static assets (a plain
// sailboat glyph, public/icons/) since the spec only asked for one
// simple icon, not a per-instance-colored set.
app.get("/manifest.json", (req, res) => {
  const db = load();
  const name = (db.settings && db.settings.clinicName) || instance.name || "Sailz";
  res.json({
    name: `${name} — Sailz`,
    short_name: name,
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0d",
    theme_color: instance.brandColor || "#c9a066",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
});
app.use(express.static(path.join(__dirname, "..", "public")));

if (!process.env.JWT_SECRET) {
  if (NODE_ENV === "production") {
    console.error("FATAL: JWT_SECRET is not set. Refusing to start in production without a real secret.");
    process.exit(1);
  }
  console.warn("WARNING: JWT_SECRET is not set — using an insecure development-only secret. This MUST be set before any real deploy.");
}
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ---------- auth ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again in 15 minutes." },
});

// A real bcrypt hash of a value nobody will ever type, computed once at
// boot — used only to give the "no such user" path the same bcrypt cost as
// a real comparison (see the login route below).
const DUMMY_HASH = bcrypt.hashSync("no-such-user-timing-decoy", 10);

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const u = load().users.find((x) => x.email === email);
  // Always run bcrypt, even when no user matches, so a nonexistent email
  // doesn't respond measurably faster than a real one with a wrong password
  // — otherwise response timing itself is a user-exists oracle.
  const ok = bcrypt.compareSync(password || "", u ? u.passHash : DUMMY_HASH);
  if (!u || !ok) return res.status(401).json({ error: "Invalid email or password" });
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" }), name: u.name, mustChangePassword: !!u.mustChangePassword });
});

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), SECRET);
    next();
  } catch { res.status(401).json({ error: "Sign in required" }); }
}

function requireOwner(req, res, next) {
  if (req.user?.role !== "owner") return res.status(403).json({ error: "Owner access required" });
  next();
}

// ---------- user management (owner-only, except change-password) ----------
app.post("/api/users/invite", auth, requireOwner, (req, res) => {
  const { email, tempPassword, role } = req.body || {};
  if (!email || !tempPassword) return res.status(400).json({ error: "email and tempPassword are required" });
  const roleValue = role === "owner" ? "owner" : "staff";
  const db = load();
  if (db.users.find((u) => u.email === email)) return res.status(409).json({ error: "A user with that email already exists" });
  const user = { id: "u" + nanoid(10), email, passHash: bcrypt.hashSync(tempPassword, 10), name: email.split("@")[0], role: roleValue, mustChangePassword: true };
  db.users.push(user);
  save();
  log("system", `${req.user.id} invited ${email} as ${roleValue}`);
  const { passHash, ...safeUser } = user;
  res.json(safeUser);
});

app.get("/api/users", auth, requireOwner, (req, res) => {
  res.json(load().users.map(({ passHash, ...u }) => u));
});

app.post("/api/auth/change-password", auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const db = load();
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (!bcrypt.compareSync(currentPassword || "", u.passHash)) return res.status(401).json({ error: "Current password is incorrect" });
  u.passHash = bcrypt.hashSync(newPassword, 10);
  u.mustChangePassword = false;
  save();
  log("system", `${u.email} changed their password`);
  res.json({ ok: true });
});

// ---------- forgot password / magic-link login ----------
// Both request paths return the exact same {ok:true} whether or not the
// email has an account — the response (and its timing) must never let a
// caller distinguish "no such user" from "email sent", or the endpoint
// becomes an account-existence oracle. Tightly rate-limited since each hit
// is a real email send attempt. The consume routes (reset/magic-consume)
// get their OWN, more generous limiter — a legitimate user retyping a
// mistyped new password, or a stale page reload, shouldn't burn through the
// same 3/hour budget as requesting the email in the first place.
const forgotLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: "Too many reset requests — try again in an hour." } });
const magicLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 3, standardHeaders: true, legacyHeaders: false, message: { error: "Too many login-link requests — try again in an hour." } });
const consumeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts — try again in an hour." } });

app.post("/api/auth/forgot", forgotLimiter, async (req, res) => {
  const { email } = req.body || {};
  const db = load();
  const u = db.users.find((x) => x.email === email);
  if (u) {
    const resetToken = nanoid(32);
    db.passwordResets.push({ token: resetToken, userId: u.id, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), used: false, createdAt: new Date().toISOString() });
    save();
    const link = `${req.protocol}://${req.get("host")}/reset/${resetToken}`;
    notify.sendEmail(u.email, "Reset your Sailz password", `<p>Reset your password (expires in 30 minutes, works once):</p><p><a href="${link}">${link}</a></p><p>Didn't request this? You can ignore this email.</p>`)
      .catch((e) => log("notify", `Password reset email error: ${e.message}`));
  }
  res.json({ ok: true });
});

app.post("/api/auth/reset", consumeLimiter, (req, res) => {
  const { token: resetToken, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  const db = load();
  const entry = db.passwordResets.find((r) => r.token === resetToken);
  if (!entry || entry.used || new Date(entry.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  }
  const u = db.users.find((x) => x.id === entry.userId);
  if (!u) return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  u.passHash = bcrypt.hashSync(newPassword, 10);
  u.mustChangePassword = false;
  entry.used = true;
  save();
  log("system", `${u.email} reset their password via emailed link`);
  res.json({ ok: true });
});

app.post("/api/auth/magic", magicLimiter, async (req, res) => {
  const { email } = req.body || {};
  const db = load();
  const u = db.users.find((x) => x.email === email);
  if (u) {
    const magicToken = nanoid(32);
    db.magicLinks.push({ token: magicToken, userId: u.id, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), used: false, createdAt: new Date().toISOString() });
    save();
    const link = `${req.protocol}://${req.get("host")}/magic/${magicToken}`;
    notify.sendEmail(u.email, "Your Sailz login link", `<p>Sign in (expires in 15 minutes, works once):</p><p><a href="${link}">${link}</a></p><p>Didn't request this? You can ignore this email.</p>`)
      .catch((e) => log("notify", `Magic-link email error: ${e.message}`));
  }
  res.json({ ok: true });
});

app.get("/magic/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "magic.html"));
});

app.post("/api/auth/magic/consume", consumeLimiter, (req, res) => {
  const { token: magicToken } = req.body || {};
  const db = load();
  const entry = db.magicLinks.find((r) => r.token === magicToken);
  if (!entry || entry.used || new Date(entry.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: "This login link is invalid or has expired — request a new one." });
  }
  const u = db.users.find((x) => x.id === entry.userId);
  if (!u) return res.status(400).json({ error: "This login link is invalid or has expired — request a new one." });
  entry.used = true;
  save();
  log("system", `${u.email} signed in via magic link`);
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" }), name: u.name, mustChangePassword: !!u.mustChangePassword });
});

app.get("/reset/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "reset.html"));
});

// ---------- dashboard aggregate ----------
app.get("/api/dashboard", auth, (req, res) => {
  const db = load();
  const today = new Date().toDateString();
  const isToday = (ts) => new Date(ts).toDateString() === today;
  const callsToday = db.calls.filter((c) => isToday(c.ts));
  const leadsToday = db.leads.filter((l) => isToday(l.createdAt));
  const booked = db.leads.filter((l) => ["booked", "seen", "audited", "billed"].includes(l.status));
  res.json({
    settings: db.settings,
    vertical: instance.vertical || null,
    // Optional per-instance nav override (instance.json's "tabs" array,
    // e.g. ["map","dash","calls","leads","orders","work"] for a
    // restaurant that doesn't book calendar appointments). null when the
    // instance doesn't declare one — the frontend then falls back to
    // showing every tab except Orders (gated by vertical/hasOrders
    // below), the exact behavior every instance had before this field
    // existed, so nothing changes for an instance that hasn't opted in.
    tabs: instance.tabs || null,
    hasOrders: db.orders.length > 0,
    demoMode: process.env.DEMO_MODE === "1",
    funnel: {
      leads: leadsToday.length || db.leads.length,
      calls: callsToday.length,
      booked: booked.length,
      seen: db.leads.filter((l) => ["seen", "audited", "billed"].includes(l.status)).length,
      claims: db.claims.length,
    },
    line: {
      callsToday: callsToday.length,
      missed: callsToday.filter((c) => c.outcome === "missed").length,
      bookedByLine: callsToday.filter((c) => c.outcome === "booked").length,
    },
    revenueEst: booked.length * (db.settings.avgVisitValue || 0),
    agents: db.agents,
    integrations: db.integrations.map(({ envKey, ...i }) => ({ ...i, connected: !!process.env[envKey] || i.status === "connected" })),
    calls: db.calls.slice(0, 8),
    appointments: db.appointments.slice(0, 8),
    claims: db.claims.filter((c) => c.status === "awaiting_approval"),
    activity: db.activity.slice(0, 80),
    leads: db.leads,
  });
});

// ---------- agent brain graph ----------
app.get("/api/brain/graph", auth, (req, res) => {
  res.json(brainGraph.buildGraph(load()));
});

app.get("/api/brain/agents/:id", auth, (req, res) => {
  const detail = brainGraph.buildAgentDetail(load(), req.params.id);
  if (!detail) return res.status(404).json({ error: "Unknown agent" });
  res.json(detail);
});

// ---------- agents ----------
app.post("/api/agents/:id/toggle", auth, (req, res) => {
  const db = load();
  const a = db.agents.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Agent not found" });
  a.on = !a.on; save();
  log("system", `${a.name} ${a.on ? "resumed" : "paused"} by owner`);
  res.json(a);
});

app.post("/api/agents/:id/run", auth, async (req, res) => {
  try { res.json({ result: await runAgent(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/agents/:id/schedule", auth, (req, res) => {
  const db = load();
  const a = db.agents.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Agent not found" });
  if (!cron.validate(req.body.schedule || "")) return res.status(400).json({ error: "Invalid cron expression" });
  a.schedule = req.body.schedule;
  a.scheduleLabel = req.body.scheduleLabel || req.body.schedule;
  save(); bootSchedules();
  res.json(a);
});

// ---------- agent catalog (self-service activation — the client's own
// "store" of what their brain can do; server/catalog.js has the state
// machine, this is just the thin HTTP wrapper) ----------
app.get("/api/catalog", auth, (req, res) => {
  res.json({ agents: catalog.getCatalog(load()) });
});

app.post("/api/catalog/:id/activate", auth, requireOwner, (req, res) => {
  const db = load();
  const result = catalog.activate(db, req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error, missing: result.missing });
  save();
  bootSchedules();
  log("system", `${req.user.id} activated ${result.agent.name}`);
  res.json(result.agent);
});

app.post("/api/catalog/:id/deactivate", auth, requireOwner, (req, res) => {
  const db = load();
  const result = catalog.deactivate(db, req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  save();
  bootSchedules();
  log("system", `${req.user.id} paused ${result.agent.name}`);
  res.json(result.agent);
});

// ---------- integrations (connector keys — env always wins; a db-stored
// key is a no-deploy convenience fallback, never echoed back in full) ----------
app.get("/api/integrations", auth, (req, res) => {
  const db = load();
  const keys = db.settings.integrationKeys || {};
  res.json({
    integrations: db.integrations.map((i) => {
      const hasEnv = !!(i.envKey && process.env[i.envKey]);
      const dbKey = keys[i.id];
      return {
        id: i.id, name: i.name, role: i.role,
        connected: hasEnv || !!dbKey,
        source: hasEnv ? "env" : dbKey ? "db" : null,
        maskedKey: dbKey ? "••••" + dbKey.slice(-4) : null,
      };
    }),
  });
});

app.post("/api/integrations/keys", auth, requireOwner, (req, res) => {
  const { id, key } = req.body || {};
  const db = load();
  const integ = db.integrations.find((i) => i.id === id);
  if (!integ) return res.status(400).json({ error: "Unknown integration id" });
  const trimmed = (key || "").trim();
  if (!trimmed) return res.status(400).json({ error: "key is required" });
  db.settings.integrationKeys = db.settings.integrationKeys || {};
  db.settings.integrationKeys[id] = trimmed;
  save();
  log("system", `${req.user.id} added a key for ${integ.name}`);
  res.json({ id, connected: true, maskedKey: "••••" + trimmed.slice(-4) });
});

// ---------- claims approval (human gate) ----------
app.post("/api/claims/:id/approve", auth, requireOwner, (req, res) => {
  const db = load();
  const c = db.claims.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Claim not found" });
  c.status = "approved"; c.approvedBy = req.user.id; save();
  log("billing", `Claim ${c.id} approved — queued for clearinghouse submission`);
  res.json(c);
});

// ---------- memory (the brain's learning — human-gated) ----------
// The librarian agent only ever writes status:"proposed" facts here. Owner
// approval is the one and only path to status:"approved", and only
// approved faq_gap/policy_correction facts ever reach syncToVapi() — see
// server/vapiSync.js. Nothing in this file writes what the phone assistant
// says.
const MEMORY_TYPES = new Set(["faq_gap", "policy_correction", "preference", "signal"]);

app.get("/api/memory", auth, (req, res) => {
  const db = load();
  const { status } = req.query;
  const memory = (status ? db.memory.filter((m) => m.status === status) : db.memory)
    .slice()
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  res.json({ memory });
});

app.post("/api/memory", auth, requireOwner, (req, res) => {
  const { type, fact, source } = req.body || {};
  if (!fact || !MEMORY_TYPES.has(type)) {
    return res.status(400).json({ error: "type (faq_gap|policy_correction|preference|signal) and fact are required" });
  }
  const db = load();
  // The owner typing a fact in directly IS the approval — there's no
  // meaningful separate review step for something a human just authored.
  const entry = {
    id: "M" + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    type, fact,
    source: source || `${req.user.id} (added manually)`,
    status: "approved",
    approvedBy: req.user.id,
    approvedAt: new Date().toISOString(),
  };
  db.memory.push(entry);
  mergePreferenceIfApplicable(db, entry);
  save();
  log("system", `${req.user.id} taught the brain a ${type} fact directly`);
  if (type === "faq_gap" || type === "policy_correction") vapiSync.scheduleSyncDebounced(req.user.id);
  res.json(entry);
});

function mergePreferenceIfApplicable(db, m) {
  if (m.type !== "preference" || !m.source) return;
  const lead = db.leads.find((l) => l.name && m.source.toLowerCase().includes(l.name.toLowerCase()));
  if (!lead) return;
  lead.preferences = lead.preferences || [];
  if (!lead.preferences.includes(m.fact)) lead.preferences.push(m.fact);
}

app.post("/api/memory/:id/approve", auth, requireOwner, (req, res) => {
  const db = load();
  const m = db.memory.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Memory fact not found" });
  m.status = "approved";
  m.approvedBy = req.user.id;
  m.approvedAt = new Date().toISOString();
  mergePreferenceIfApplicable(db, m);
  save();
  log("system", `Memory fact ${m.id} (${m.type}) approved by ${req.user.id}`);
  if (m.type === "faq_gap" || m.type === "policy_correction") {
    vapiSync.scheduleSyncDebounced(req.user.id);
    vapiAssistant.invalidatePromptCache();
  }
  res.json(m);
});

app.post("/api/memory/:id/reject", auth, requireOwner, (req, res) => {
  const db = load();
  const m = db.memory.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "Memory fact not found" });
  m.status = "rejected";
  m.rejectedBy = req.user.id;
  save();
  log("system", `Memory fact ${m.id} (${m.type}) rejected by ${req.user.id}`);
  res.json(m);
});

// Manual re-sync / "Push now" button — same code path the debounced
// post-approval sync and the weekly cron use.
app.post("/api/vapi/sync", auth, requireOwner, async (req, res) => {
  try {
    const result = await vapiSync.syncToVapi(req.user.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets the operator eyeball exactly what a caller would get from
// assistant-request (or what's cached to send) before/after flipping
// VAPI_ASSISTANT_REQUEST on for real.
app.get("/api/vapi/preview-prompt", auth, requireOwner, (req, res) => {
  res.json({ prompt: vapiAssistant.composeSystemPrompt() });
});

// ---------- heartbeat (every instance answers; only HQ polls) ----------
// Service-to-service, not a user login — a shared secret header, checked
// against THIS deployment's own HEARTBEAT_KEY. No key configured here
// means nobody can ever successfully poll this instance (safe default,
// not an open-by-omission bug). No PHI in the response — see
// heartbeat.js's own header for exactly what is and isn't included.
app.get("/api/heartbeat", (req, res) => {
  const key = process.env.HEARTBEAT_KEY;
  if (!key || req.headers["x-sailz-hq-key"] !== key) return res.sendStatus(403);
  res.json(heartbeat.buildSnapshot());
});

// ---------- HQ client board (HQ-only — requireHQ, same reasoning as the
// onboarding console) ----------
app.get("/api/hq/clients", requireHQ, auth, requireOwner, (req, res) => {
  const db = load();
  res.json({
    clients: (db.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      addedAt: c.addedAt,
      mrr: c.mrr || 0,
      maskedKey: c.key ? "••••" + c.key.slice(-4) : null,
      status: hqClients.clientStatus(c),
      latest: (c.heartbeats && c.heartbeats[c.heartbeats.length - 1]) || null,
      heartbeats: c.heartbeats || [],
    })),
  });
});

app.post("/api/hq/clients", requireHQ, auth, requireOwner, async (req, res) => {
  const { name, baseUrl, key } = req.body || {};
  if (!name || !baseUrl || !key) return res.status(400).json({ error: "name, baseUrl, and key are required" });
  const db = load();
  const client = { id: "CL" + nanoid(10), name, baseUrl: baseUrl.replace(/\/+$/, ""), key, addedAt: new Date().toISOString(), heartbeats: [] };
  db.clients.push(client);
  save();
  log("system", `${req.user.id} added client "${name}" to the HQ board`);
  const snap = await hqClients.pollOne(client); // immediate poll so the card isn't blank until the next 10-min tick
  save();
  res.json({ id: client.id, latest: snap });
});

app.patch("/api/hq/clients/:id", requireHQ, auth, requireOwner, (req, res) => {
  const db = load();
  const c = db.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const { name, baseUrl, key, mrr } = req.body || {};
  if (name) c.name = name;
  if (baseUrl) c.baseUrl = baseUrl.replace(/\/+$/, "");
  if (key) c.key = key;
  // MRR is manual-entry-only (Stripe/automated billing is explicitly out
  // of scope) — 0 is a valid value (a not-yet-billing pilot), so check
  // for undefined rather than falsy.
  if (mrr !== undefined) c.mrr = Number(mrr) || 0;
  save();
  res.json({ ok: true });
});

app.delete("/api/hq/clients/:id", requireHQ, auth, requireOwner, (req, res) => {
  const db = load();
  const before = db.clients.length;
  db.clients = db.clients.filter((c) => c.id !== req.params.id);
  save();
  if (db.clients.length < before) log("system", `${req.user.id} removed a client from the HQ board`);
  res.json({ ok: true, removed: before - db.clients.length });
});

app.post("/api/hq/clients/:id/poll", requireHQ, auth, requireOwner, async (req, res) => {
  const db = load();
  const c = db.clients.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Client not found" });
  const snap = await hqClients.pollOne(c);
  save();
  res.json(snap);
});

// ---------- attention inbox ----------
// Computed entirely from data already in the store — no new infra. Each
// item's action either maps to a real one-click route (method POST) or is
// a navigate-only hint for the frontend (method GET — "go look at this",
// not an API call).
function hasFollowUpCall(db, missedCall) {
  return db.calls.some((c) => c.who === missedCall.who && new Date(c.ts) > new Date(missedCall.ts));
}

app.get("/api/attention", auth, (req, res) => {
  const db = load();
  const items = [];
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  db.leads
    .filter((l) => l.status === "new" && Date.now() - new Date(l.createdAt).getTime() > TWO_HOURS)
    .forEach((l) => {
      items.push({
        type: "new_lead", severity: "high",
        title: `${l.name} hasn't been called back`,
        detail: `New lead from ${l.source || "unknown source"}${l.service ? " — " + l.service : ""}, waiting since ${l.createdAt}.`,
        action: { label: "Call back", method: "POST", path: `/api/leads/${l.id}/queue-call` },
      });
    });

  db.appointments
    .filter((a) => a.status === "unconfirmed")
    .forEach((a) => {
      items.push({
        type: "unconfirmed_appointment", severity: "medium",
        title: `${a.name || "Appointment"} needs confirming`,
        detail: `${a.service || "Visit"} at ${a.time}, booked via ${a.source || "unknown"} — not yet confirmed.`,
        action: { label: "Confirm", method: "POST", path: `/api/appointments/${a.id}/confirm` },
      });
    });

  db.claims
    .filter((c) => c.status === "awaiting_approval")
    .forEach((c) => {
      const amount = c.amount != null ? `$${c.amount}` : "amount pending";
      items.push({
        type: "claim_awaiting_approval", severity: "high",
        title: `Claim ${c.id} awaiting approval`,
        detail: `${(c.codes || []).map((x) => x.code || x).join(", ") || "Codes pending"} — ${amount}.`,
        action: { label: "Review", method: "GET", path: "dash" },
      });
    });

  db.calls
    .filter((c) => c.outcome === "missed" && !hasFollowUpCall(db, c))
    .forEach((c) => {
      const lead = db.leads.find((l) => l.name === c.who || l.phone === c.who);
      items.push({
        type: "missed_call", severity: "medium",
        title: `Missed call from ${c.who}`,
        detail: `${c.summary || "No summary"} — no follow-up call since.`,
        action: lead ? { label: "Have agent call back", method: "POST", path: `/api/leads/${lead.id}/queue-call` } : null,
      });
    });

  db.leads
    .filter((l) => l.status === "proposed" && l.signal)
    .forEach((l) => {
      items.push({
        type: "proposed_lead", severity: "low",
        title: `Signal: ${l.name} — proposed lead, review`,
        detail: `${l.signal.reason || ""}${l.signal.link ? " — " + l.signal.link : ""}`,
        action: { label: "Approve", method: "POST", path: `/api/leads/${l.id}/approve-proposed` },
      });
    });

  db.leads
    .filter((l) => l.type === "rfp" && l.rfp?.status === "awaiting_approval")
    .forEach((l) => {
      items.push({
        type: "rfp_draft", severity: "high",
        title: `RFP from ${l.name} — response drafted, review & send`,
        detail: `${l.rfp.eventDate ? "Event " + l.rfp.eventDate + " · " : ""}${l.rfp.headcount ? l.rfp.headcount + " guests · " : ""}"${(l.rfp.draftBody || "").slice(0, 140)}"`,
        action: { label: "Send drafted reply", method: "POST", path: `/api/leads/${l.id}/rfp/approve` },
      });
    });

  const proposedMemory = db.memory.filter((m) => m.status === "proposed");
  if (proposedMemory.length) {
    items.push({
      type: "memory_review", severity: "medium",
      title: `Brain learned ${proposedMemory.length} new thing${proposedMemory.length > 1 ? "s" : ""} — review`,
      detail: proposedMemory.slice(0, 3).map((m) => m.fact).join(" · ").slice(0, 160),
      action: { label: "Review", method: "GET", path: "memory" },
    });
  }

  const FIVE_MIN = 5 * 60 * 1000;
  db.orders
    .filter((o) => o.status === "new" && Date.now() - new Date(o.ts).getTime() > FIVE_MIN)
    .forEach((o) => {
      items.push({
        type: "stale_order", severity: "high",
        title: `${o.customer.name || "An order"} — kitchen hasn't started`,
        detail: `$${o.total.toFixed(2)} order placed ${o.ts}, still sitting in "new".`,
        action: { label: "Open orders", method: "GET", path: "orders" },
      });
    });

  db.onboardings
    .filter((o) => o.status === "completed")
    .forEach((o) => {
      items.push({
        type: "onboarding_ready", severity: "medium",
        title: `${o.clientName} finished onboarding — review & activate`,
        detail: `${(o.draft?.memoryFacts || []).length} proposed memory fact(s), draft slug "${o.draft?.instanceJson?.id || "?"}".`,
        action: { label: "Review", method: "GET", path: `onboarding/${o.id}` },
      });
    });

  // Voice memos land here whenever no DEEPGRAM_API_KEY/ASSEMBLYAI_API_KEY was
  // configured at upload time (server/onboarding.js's processFile) — never a
  // dead end for the client, just a manual-review queue for Sailz.
  db.onboardings.forEach((o) => {
    const queuedAudio = (o.data?.brainDump?.files || []).filter((f) => f.kind === "audio" && f.status === "queued");
    if (queuedAudio.length) {
      items.push({
        type: "onboarding_audio_review", severity: "low",
        title: `${o.clientName} — ${queuedAudio.length} voice recording${queuedAudio.length > 1 ? "s" : ""} ${queuedAudio.length > 1 ? "need" : "needs"} manual review`,
        detail: `No transcription service was connected when these were uploaded — listen and fold anything useful into the draft by hand.`,
        action: { label: "Review", method: "GET", path: `onboarding/${o.id}` },
      });
    }
  });

  // Same as onboarding's own audio-review item above, but for the
  // post-onboarding Teach surface (db.teachFiles) on THIS live instance.
  const queuedTeachAudio = db.teachFiles.filter((f) => f.kind === "audio" && f.status === "queued");
  if (queuedTeachAudio.length) {
    items.push({
      type: "teach_audio_review", severity: "low",
      title: `${queuedTeachAudio.length} voice recording${queuedTeachAudio.length > 1 ? "s" : ""} ${queuedTeachAudio.length > 1 ? "need" : "needs"} manual review`,
      detail: `No transcription service is connected — listen and teach the brain what's in them by hand.`,
      action: { label: "Review", method: "GET", path: "teach" },
    });
  }

  const proposedProfileEdits = db.profileEdits.filter((e) => e.status === "proposed");
  if (proposedProfileEdits.length) {
    items.push({
      type: "profile_edit_review", severity: "medium",
      title: `${proposedProfileEdits.length} profile edit${proposedProfileEdits.length > 1 ? "s" : ""} proposed — review`,
      detail: `New service, price, or hours changes learned from something you taught the brain — nothing's live until you approve.`,
      action: { label: "Review", method: "GET", path: "memory" },
    });
  }

  res.json({ items, count: items.length });
});

app.post("/api/leads/:id/queue-call", auth, (req, res) => {
  const db = load();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.status === "new") lead.status = "qualified";
  lead.priorityCall = true;
  save();
  log("system", `${lead.name} queued for a priority callback by ${req.user.id}`);
  res.json(lead);
});

// One-tap pipeline actions for the mobile Leads tab — the same "new ->
// contacted -> booked -> won/lost" stage grouping index.html's LEAD_STAGE
// computes for display maps onto the real status vocabulary other code
// already depends on (booked/closed_lost predate this stage), so this is
// additive, not a rename of anything.
app.post("/api/leads/:id/mark-booked", auth, (req, res) => {
  const db = load();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  lead.status = "booked";
  save();
  log("system", `${lead.name} marked booked by ${req.user.id}`);
  res.json(lead);
});
app.post("/api/leads/:id/mark-lost", auth, (req, res) => {
  const db = load();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  lead.status = "closed_lost";
  save();
  log("system", `${lead.name} marked lost by ${req.user.id}`);
  res.json(lead);
});

// Speed-to-lead auto-queue toggle — surfaced in the calling agent's
// catalog panel, not a dedicated settings page. Default off; reading the
// current value is just db.settings.autoCallNewLeads via the existing
// GET /api/dashboard (which already returns settings wholesale).
app.post("/api/settings/auto-call-new-leads", auth, requireOwner, (req, res) => {
  const db = load();
  db.settings.autoCallNewLeads = !!req.body?.enabled;
  save();
  log("system", `${req.user.id} turned auto-call-new-leads ${db.settings.autoCallNewLeads ? "on" : "off"}`);
  res.json({ autoCallNewLeads: db.settings.autoCallNewLeads });
});

// Do-not-call list — owner-managed only, never auto-populated. Checked
// by server/leadQueue.js before any automated outbound contact.
app.get("/api/dnc", auth, requireOwner, (req, res) => {
  res.json({ dnc: load().dnc });
});
app.post("/api/dnc", auth, requireOwner, (req, res) => {
  const phone = (req.body?.phone || "").trim();
  if (!phone) return res.status(400).json({ error: "phone is required" });
  const db = load();
  if (!leadQueue.isDNC(db, phone)) db.dnc.push(phone);
  save();
  log("system", `${req.user.id} added ${maskPhone(phone)} to the do-not-call list`);
  res.json({ dnc: db.dnc });
});
app.delete("/api/dnc/:phone", auth, requireOwner, (req, res) => {
  const db = load();
  const digits = req.params.phone.replace(/\D/g, "");
  db.dnc = db.dnc.filter((n) => n.replace(/\D/g, "") !== digits);
  save();
  res.json({ dnc: db.dnc });
});

// Signal watcher's per-instance watchlist — queries only matter with
// BRAVE_API_KEY set (see signalWatcher.js), feeds work either way.
app.post("/api/settings/signal-watch", auth, requireOwner, (req, res) => {
  const db = load();
  const { queries, feeds } = req.body || {};
  db.settings.signalWatch = {
    queries: Array.isArray(queries) ? queries.filter(Boolean) : [],
    feeds: Array.isArray(feeds) ? feeds.filter(Boolean) : [],
  };
  save();
  log("system", `${req.user.id} updated the signal watchlist`);
  res.json(db.settings.signalWatch);
});

// A proposed lead (signal watcher, never auto-contacted) becomes a real
// one only on explicit owner approval — which MAY then auto-queue per
// Stage 2's guardrails (only if it has a phone number, which most public
// signals won't; a safe no-op otherwise).
app.post("/api/leads/:id/approve-proposed", auth, requireOwner, (req, res) => {
  const db = load();
  const lead = db.leads.find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  if (lead.status !== "proposed") return res.status(400).json({ error: "Not a proposed lead" });
  lead.status = "new";
  leadQueue.maybeAutoQueueLead(db, lead);
  save();
  log("system", `${req.user.id} approved a proposed lead: ${lead.name}`);
  res.json(lead);
});

app.post("/api/appointments/:id/confirm", auth, (req, res) => {
  const db = load();
  const appt = db.appointments.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });
  appt.status = "confirmed";
  save();
  log("system", `Appointment ${appt.id} confirmed by ${req.user.id}`);
  res.json(appt);
});

// ---------- chat with the brain (read-only) ----------
// Simple in-memory sliding-window limiter — 20 requests/min per user.
// Fine for a single-process deployment; would need a shared store behind
// a load balancer, which this app isn't run behind.
const chatRateLog = new Map();
function chatRateLimited(userId) {
  const now = Date.now();
  const windowStart = now - 60 * 1000;
  const hits = (chatRateLog.get(userId) || []).filter((t) => t > windowStart);
  hits.push(now);
  chatRateLog.set(userId, hits);
  return hits.length > 20;
}

app.post("/api/chat", auth, async (req, res) => {
  if (chatRateLimited(req.user.id)) return res.status(429).json({ error: "Too many chat requests — wait a moment and try again." });
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: "messages is required" });
  try {
    const { reply, actions } = await chat.runChat(messages);
    res.json({ reply, actions: actions || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- calls ----------
app.get("/api/calls", auth, (req, res) => {
  const db = load();
  const { filter, period } = req.query;
  let calls = db.calls;
  if (period === "today") {
    const today = new Date().toDateString();
    calls = calls.filter((c) => new Date(c.ts).toDateString() === today);
  } else if (period === "week") {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    calls = calls.filter((c) => new Date(c.ts).getTime() >= weekAgo);
  }
  if (filter === "missed") calls = calls.filter((c) => c.outcome === "missed");
  else if (filter === "booked") calls = calls.filter((c) => c.outcome === "booked");
  res.json({ calls });
});

// ---------- calendar ----------
app.get("/api/calendar/events", auth, async (req, res) => {
  const db = load();
  const from = req.query.from || new Date().toISOString();
  const to = req.query.to || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const google = await calendarApi.getEventsInRange(from, to);
  const localAppts = db.appointments.filter((a) => a.time >= from && a.time <= to);
  const localGoogleIds = new Set(localAppts.map((a) => a.googleEventId).filter(Boolean));
  const events = localAppts.map((a) => ({
    id: a.id,
    start: a.time,
    end: a.time,
    title: a.service || "Appointment",
    patient: a.name || null,
    service: a.service || null,
    source: a.source === "AI line" ? "ai_line" : a.source || "manual",
    status: a.status,
    googleEventId: a.googleEventId || null,
  }));
  // Google events not already represented by a local appointment row —
  // dedupe by googleEventId so an AI-booked event never shows twice.
  for (const e of google.events) {
    if (localGoogleIds.has(e.googleEventId)) continue;
    events.push({ id: null, start: e.start, end: e.end, title: e.title, patient: null, service: null, source: "google", status: "confirmed", googleEventId: e.googleEventId });
  }
  res.json({ events, googleConnected: google.ok });
});

app.post("/api/appointments/:id/cancel", auth, (req, res) => {
  const db = load();
  const appt = db.appointments.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ error: "Appointment not found" });
  appt.status = "cancelled";
  save();
  log("system", `Appointment ${appt.id} (${appt.name || "unknown"}) cancelled by ${req.user.id}`);
  res.json(appt);
});

app.post("/api/calendar/block", auth, requireOwner, async (req, res) => {
  const { startISO, endISO, reason } = req.body || {};
  if (!startISO || !endISO) return res.status(400).json({ error: "startISO and endISO are required" });
  const out = await calendarApi.blockTime({ startISO, endISO, reason });
  if (!out.configured) return res.json({ blocked: false, reason: "Google Calendar isn't connected — nothing to block against." });
  if (out.error) return res.status(502).json({ blocked: false, reason: out.error });
  log("system", `${req.user.id} blocked ${startISO} – ${endISO}${reason ? " (" + reason + ")" : ""}`);
  res.json({ blocked: true, eventId: out.eventId });
});

// ---------- orders (restaurant vertical — additive, Shine Dental never
// has any rows here since it has no place_order tool) ----------
const ORDER_STATUS_SEQUENCE = ["new", "preparing", "ready", "picked_up"];

app.get("/api/orders", auth, (req, res) => {
  const db = load();
  const { status } = req.query;
  const list = (status ? db.orders.filter((o) => o.status === status) : db.orders)
    .slice()
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  res.json({ orders: list });
});

app.post("/api/orders/:id/advance", auth, (req, res) => {
  const db = load();
  const o = db.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  const idx = ORDER_STATUS_SEQUENCE.indexOf(o.status);
  if (idx === -1 || idx === ORDER_STATUS_SEQUENCE.length - 1) {
    return res.status(400).json({ error: `Order is ${o.status} — nothing further to advance to` });
  }
  o.status = ORDER_STATUS_SEQUENCE[idx + 1];
  save();
  log("system", `Order ${o.id} (${o.customer.name || "unknown"}) advanced to ${o.status} by ${req.user.id}`);
  res.json(o);
});

app.post("/api/orders/:id/cancel", auth, (req, res) => {
  const db = load();
  const o = db.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  o.status = "cancelled";
  save();
  log("system", `Order ${o.id} (${o.customer.name || "unknown"}) cancelled by ${req.user.id}`);
  res.json(o);
});

// ---------- demo mode ----------
// Gated behind DEMO_MODE=1 even for owners — this is a destructive
// clear-real-data endpoint by design ("so the pitch always starts clean"),
// and the one thing that must never happen is someone fat-fingering this
// on a real client's live deployment. Refusing outright when DEMO_MODE
// isn't explicitly "1" is the safety rail for that.
app.post("/api/demo/reset", auth, requireOwner, (req, res) => {
  if (process.env.DEMO_MODE !== "1") {
    return res.status(403).json({ error: "Demo reset is disabled — DEMO_MODE is not set to 1 on this deployment." });
  }
  const db = load();
  db.orders = [];
  db.calls = [];
  db.leads = [];
  save();
  log("system", `${req.user.id} reset demo data (orders/calls/leads cleared)`);
  res.json({ ok: true });
});

// ---------- onboarding wizard ----------
// The wizard never writes live config: /onboard/:token is public but the
// token is single-use (dead once the client finishes or Sailz activates),
// and every write lands in db.onboardings[].data/draft until an owner
// explicitly activates it (see the /api/onboarding/admin/* routes below).
const onboardingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter(req, file, cb) {
    const ok = /\.(txt|pdf|docx|jpe?g|png|heic|heif|m4a|mp3|wav|webm)$/i.test(file.originalname || "");
    cb(ok ? null : new Error(`"${file.originalname}" isn't a supported file type — try .txt, .pdf, .docx, a photo (.jpg/.png/.heic), or audio (.m4a/.mp3/.wav/.webm).`), ok);
  },
});
// multer/fileFilter errors otherwise fall through to Express's default HTML
// error page — the wizard needs JSON so it can show a friendly inline message.
function handleUpload(middleware) {
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "One of those files is over the 25MB-per-file limit." });
      if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Up to 20 files per batch — try again with fewer, you can always upload more after." });
      res.status(400).json({ error: err.message || "Upload failed." });
    });
  };
}
// Public, unauthenticated, and each hop can trigger a Claude call — a
// tighter ceiling than the webhook limiter, keyed by IP.
const onboardingLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.post("/api/onboarding/create", requireHQ, auth, requireOwner, (req, res) => {
  const { clientName } = req.body || {};
  if (!clientName) return res.status(400).json({ error: "clientName is required" });
  const entry = onboarding.createOnboarding({ clientName, createdBy: req.user.id });
  res.json({ token: entry.token, id: entry.id, url: `${req.protocol}://${req.get("host")}/onboard/${entry.token}` });
});

app.get("/onboard/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "onboard.html"));
});

// Owner review/activation routes are registered BEFORE the public
// /api/onboarding/:token/* routes below — Express matches path segments in
// registration order, and "admin" would otherwise be swallowed as a :token
// value by the earlier (identically-shaped) public route.
app.get("/api/onboarding/admin", requireHQ, auth, requireOwner, (req, res) => {
  res.json({ onboardings: onboarding.listOnboardings() });
});

app.get("/api/onboarding/admin/:id", requireHQ, auth, requireOwner, (req, res) => {
  const found = onboarding.getForReview(req.params.id);
  if (!found) return res.status(404).json({ error: "Onboarding not found" });
  res.json(found);
});

app.post("/api/onboarding/admin/:id/draft", requireHQ, auth, requireOwner, (req, res) => {
  const result = onboarding.updateDraft(req.params.id, req.body || {});
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.onboarding);
});

app.post("/api/onboarding/admin/:id/activate", requireHQ, auth, requireOwner, async (req, res) => {
  try {
    const result = await onboarding.activateOnboarding(req.params.id, req.user.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lets Sailz actually listen to / view a raw photo or voice memo a client
// uploaded (needed for the "queued for manual review" path when no
// transcription key is set). Content-Type is derived from a fixed
// extension allowlist — NEVER the uploader's self-reported mimetype — and
// the requested path must exactly match a storedPath this onboarding's own
// upload pipeline already recorded, so this can't be turned into an
// arbitrary-file-read or a stored-XSS-via-spoofed-Content-Type vector.
const RAW_UPLOAD_CONTENT_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".webm": "audio/webm" };
app.get("/api/onboarding/admin/:id/upload", requireHQ, auth, requireOwner, (req, res) => {
  const o = onboarding.getById(req.params.id);
  if (!o) return res.status(404).json({ error: "Onboarding not found" });
  const rel = req.query.path;
  const file = (o.data?.brainDump?.files || []).find((f) => f.storedPath && f.storedPath === rel);
  if (!file) return res.status(404).json({ error: "File not found" });
  const abs = path.join(path.dirname(DB_PATH), file.storedPath);
  const type = RAW_UPLOAD_CONTENT_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.name || "upload")}"`);
  // fs.createReadStream directly rather than res.sendFile/send() — send's
  // dotfile guard 404s any path with a dot-prefixed segment (e.g. a
  // DB_PATH under a dotfile directory in local dev), which is irrelevant
  // here since storedPath is only ever a value this server itself wrote
  // and already validated above, never user input.
  const stream = fs.createReadStream(abs);
  stream.on("error", () => { if (!res.headersSent) res.status(404).end(); });
  stream.pipe(res);
});

app.get("/api/onboarding/:token", onboardingLimiter, (req, res) => {
  const result = onboarding.getPublicState(req.params.token);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.onboarding);
});

app.post("/api/onboarding/:token/step", onboardingLimiter, (req, res) => {
  const { step, data } = req.body || {};
  if (!step || data === undefined) return res.status(400).json({ error: "step and data are required" });
  const result = onboarding.saveStep(req.params.token, step, data);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.onboarding);
});

app.post("/api/onboarding/:token/brain-dump", onboardingLimiter, handleUpload(onboardingUpload.array("files", 20)), async (req, res) => {
  try {
    const result = await onboarding.runBrainDump(req.params.token, { text: req.body?.text || "", files: req.files || [] });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.onboarding);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/onboarding/:token/interview/next", onboardingLimiter, async (req, res) => {
  try {
    const result = await onboarding.nextInterviewQuestion(req.params.token, { answers: req.body?.answers || [] });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/onboarding/:token/complete", onboardingLimiter, async (req, res) => {
  try {
    const result = await onboarding.completeOnboarding(req.params.token);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(result.onboarding);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Teach Your Brain (post-onboarding, forever) ----------
// Same drop-anything pipeline as the onboarding wizard's brain dump
// (server/ingest.js), but scoped to the live instance instead of a token,
// and open to any logged-in user (owner or staff) — this is a client
// surface, not a Sailz one. Facts flow into the existing db.memory
// approval queue (librarian dedup via isSameFact, same as every other
// fact source); profile-shaped extractions (new service, price/hours
// change) become a proposed db.profileEdits entry with a diff preview
// instead of ever silently overwriting anything.
const teachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
  fileFilter(req, file, cb) {
    const ok = /\.(txt|pdf|docx|jpe?g|png|heic|heif|m4a|mp3|wav|webm)$/i.test(file.originalname || "");
    cb(ok ? null : new Error(`"${file.originalname}" isn't a supported file type — try .txt, .pdf, .docx, a photo (.jpg/.png/.heic), or audio (.m4a/.mp3/.wav/.webm).`), ok);
  },
});
const teachLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

app.post("/api/teach/upload", auth, teachLimiter, handleUpload(teachUpload.array("files", 20)), async (req, res) => {
  try {
    const text = (req.body?.text || "").trim();
    const files = req.files || [];
    if (!text && !files.length) return res.status(400).json({ error: "Type something or attach a file first." });

    const db = load();
    const processed = [];
    for (const f of files) processed.push(await ingest.processFile(f, "teach", instance.id));

    const parsedText = processed.filter((f) => f.status === "parsed" && f.text).map((f) => `\n\n[From ${f.name}]\n${f.text}`).join("\n");
    const corpus = [text, parsedText].join("\n").trim();
    const extractedProfile = corpus
      ? await ingest.structureCorpus(corpus)
      : { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [] };
    const imageFacts = processed.filter((f) => f.kind === "image" && f.imageProfile?.facts?.length).flatMap((f) => f.imageProfile.facts);
    const allFacts = [...(extractedProfile.facts || []), ...imageFacts];

    const source = files.length ? `Teach: ${files.map((f) => f.originalname).join(", ")}` : "Teach: typed note";
    const proposedFacts = [];
    for (const f of allFacts) {
      const candidate = { type: "policy_correction", fact: f.fact, source };
      // Only checked against db.memory's EXISTING entries, never against
      // other facts from this same batch: isSameFact's source-overlap
      // heuristic treats "same source" as a strong same-event signal, but
      // every fact from one Teach upload shares this exact source string —
      // comparing within the batch would falsely dedup unrelated facts
      // that just happen to come from the same photo/note.
      const isDup = db.memory.some((e) => isSameFact(e, candidate));
      if (isDup) continue;
      const entry = { id: "M" + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), status: "proposed", ...candidate };
      db.memory.push(entry);
      proposedFacts.push(entry);
    }

    const diff = diffProfileFragment(profile, extractedProfile);
    let profileEdit = null;
    if (diff) {
      profileEdit = { id: "PE" + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), status: "proposed", source, diff };
      db.profileEdits.push(profileEdit);
    }

    const teachFileRecords = processed.map((f) => ({
      id: "TF" + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(),
      name: f.name, mimetype: f.mimetype, size: f.size, kind: f.kind, status: f.status,
      note: f.note || null, storedPath: f.storedPath || null,
    }));
    db.teachFiles.push(...teachFileRecords);

    save();
    log("system", `${req.user.id} taught the brain — ${proposedFacts.length} fact(s) proposed${profileEdit ? ", 1 profile edit proposed" : ""}`);
    res.json({ files: teachFileRecords, extractedProfile, proposedFacts, profileEdit });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Same raw-bytes pattern as the onboarding admin route above — whitelisted
// against storedPath values this server itself already recorded, Content-
// Type derived from a fixed extension map, never the uploader's mimetype.
// auth only (not requireOwner) so staff can also listen/look, matching
// GET /api/memory's own access level.
app.get("/api/teach/upload", auth, (req, res) => {
  const db = load();
  const rel = req.query.path;
  const file = db.teachFiles.find((f) => f.storedPath && f.storedPath === rel);
  if (!file) return res.status(404).json({ error: "File not found" });
  const abs = path.join(path.dirname(DB_PATH), file.storedPath);
  const type = RAW_UPLOAD_CONTENT_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.name || "upload")}"`);
  const stream = fs.createReadStream(abs);
  stream.on("error", () => { if (!res.headersSent) res.status(404).end(); });
  stream.pipe(res);
});

app.get("/api/profile-edits", auth, (req, res) => {
  const db = load();
  const { status } = req.query;
  const items = (status ? db.profileEdits.filter((e) => e.status === status) : db.profileEdits)
    .slice()
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  res.json({ profileEdits: items });
});

app.post("/api/profile-edits/:id/approve", auth, requireOwner, (req, res) => {
  const db = load();
  const e = db.profileEdits.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Profile edit not found" });
  if (e.status !== "proposed") return res.status(409).json({ error: `Already ${e.status}.` });
  applyProfileEdit(profile, e.diff); // live immediately — mutates the same object agents.js/vapiAssistant.js already read
  e.status = "approved";
  e.approvedBy = req.user.id;
  e.approvedAt = new Date().toISOString();
  save();
  vapiAssistant.invalidatePromptCache();
  vapiSync.scheduleSyncDebounced(req.user.id);
  log("system", `Profile edit ${e.id} approved by ${req.user.id} — live immediately, no redeploy`);
  res.json(e);
});

app.post("/api/profile-edits/:id/reject", auth, requireOwner, (req, res) => {
  const db = load();
  const e = db.profileEdits.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: "Profile edit not found" });
  e.status = "rejected";
  e.rejectedBy = req.user.id;
  save();
  log("system", `Profile edit ${e.id} rejected by ${req.user.id}`);
  res.json(e);
});

// ---------- webhooks (no auth; verify per-provider signatures in prod) ----------

// Moderate ceiling — real call volume for a single clinic is nowhere near
// this; it's a burst brake against abuse, not a throttle on legitimate
// traffic. Keyed by IP; Vapi/Meta/Google each call from a small, stable set
// of source IPs in practice.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

function formatAvailability(out, dateISO) {
  if (out.invalidDate) return "I didn't catch that date clearly — could you repeat it?";
  if (!out.configured) return "I'm not able to check the live calendar right now — let me have a team member confirm a time and call you back.";
  if (out.closed) return `We're closed on ${dateISO}. Would another day work?`;
  if (!out.slots.length) return `I don't see any open slots on ${dateISO} for that. Would another day work?`;
  const times = out.slots
    .map((iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: calendarApi.tz() }))
    .join(", ");
  return `On ${dateISO} I have ${times} open.`;
}

// Vapi's tool-call payload nests the function name/arguments under
// `function: {name, arguments}` (arguments as a JSON string) rather than
// flat fields, and the array key has been observed as both `toolCallList`
// and `toolCalls` depending on call path — normalize defensively instead
// of assuming one exact shape, since guessing wrong here silently breaks
// every live call ("Unknown tool." with no visible error).
function normalizeToolCall(raw) {
  const fn = raw.function || {};
  let args = raw.arguments ?? fn.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { id: raw.id, name: raw.name || fn.name, arguments: args || {} };
}

// Find-or-create by phone, so every caller who gives their name/number
// becomes a lead — whether or not they end up booking — not just the ones
// who happened to already exist from an ad webhook.
function upsertLead(db, { name, phone, service, source }) {
  let lead = db.leads.find((l) => l.phone === phone);
  if (lead) {
    if (name) lead.name = name;
    if (service && !lead.service) lead.service = service;
  } else {
    lead = { id: "L" + Date.now(), name: name || "Unknown caller", phone, source: source || "ai_line", service: service || "", status: "new", createdAt: new Date().toISOString() };
    db.leads.unshift(lead);
  }
  return lead;
}

// Vapi: live tool calls during an active call, and the end-of-call report
app.post("/webhooks/vapi", webhookLimiter, async (req, res) => {
  if (process.env.VAPI_SERVER_SECRET && req.headers["x-vapi-secret"] !== process.env.VAPI_SERVER_SECRET) {
    return res.sendStatus(403);
  }
  // Heartbeat's "last webhook seen" health flag (server/heartbeat.js) —
  // stamped on any authenticated hit, every message type, since even an
  // assistant-request ping confirms this endpoint is alive and reachable.
  load().settings.lastWebhookAt = new Date().toISOString(); save();
  const m = req.body?.message || req.body || {};

  // assistant-request: Vapi asks us what assistant config to use for THIS
  // call, in real time, before it connects. Flag off -> fall through per
  // Vapi's own spec (an empty/no-op response) so it uses the fallback
  // assistant attached in the dashboard, exactly like every deployment
  // that never enables this at all.
  if (m.type === "assistant-request") {
    if (!VAPI_ASSISTANT_REQUEST) return res.json({});
    const started = Date.now();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const assistant = vapiAssistant.composeAssistantConfig(baseUrl);
    const ms = Date.now() - started;
    log("system", `Vapi assistant-request served in ${ms}ms${ms >= 300 ? " (over the 300ms target)" : ""}`);
    return res.json({ assistant });
  }

  if (m.type === "tool-calls") {
    const db = load();
    const results = [];
    for (const rawTc of m.toolCallList || m.toolCalls || []) {
      const tc = normalizeToolCall(rawTc);
      try {
        if (tc.name === "check_availability") {
          const { date, service } = tc.arguments || {};
          const out = await calendarApi.getAvailability(date, calendarApi.serviceDurationMinutes(service));
          results.push({ toolCallId: tc.id, result: formatAvailability(out, date) });
        } else if (tc.name === "save_contact") {
          const { name, phone, service } = tc.arguments || {};
          if (!phone) {
            results.push({ toolCallId: tc.id, result: "I need a callback number to save that — could you repeat it?" });
            continue;
          }
          const lead = upsertLead(db, { name, phone, service, source: "ai_line" });
          save();
          log("lead", `${lead.name} (${maskPhone(lead.phone)}) called in${service ? " about " + service : ""} — saved to leads`);
          results.push({ toolCallId: tc.id, result: "Got it, saved." });
        } else if (tc.name === "book_appointment") {
          const { date, time, name, phone, service } = tc.arguments || {};
          if (!calendarApi.isValidDateISO(date)) {
            results.push({ toolCallId: tc.id, result: "I didn't catch that date clearly — could you repeat it?" });
            continue;
          }
          const parsedTime = calendarApi.parseTimeArg(time);
          if (!parsedTime) {
            results.push({ toolCallId: tc.id, result: "I didn't catch that time clearly — could you repeat it, like '2:30 PM'?" });
            continue;
          }
          const existing = db.appointments.find((a) => a.vapiCallId === m.call?.id && a.googleEventId);
          if (existing) {
            results.push({ toolCallId: tc.id, result: `You're already booked — confirmed for ${existing.time}.` });
            continue;
          }
          const direction = m.call?.type === "outboundPhoneCall" ? "outbound" : "inbound";
          const startISO = calendarApi.zonedTimeToISO(date, parsedTime.hh, parsedTime.mm, calendarApi.tz());
          const out = await calendarApi.bookAppointment({ name, phone, service, startISO, durationMinutes: calendarApi.serviceDurationMinutes(service), direction });
          if (out.eventId) {
            db.appointments.unshift({
              id: "A" + Date.now(), time: startISO, name, phone, service, source: "AI line", status: "confirmed",
              googleEventId: out.eventId, vapiCallId: m.call?.id,
            });
            const lead = upsertLead(db, { name, phone, service, source: "ai_line" });
            lead.status = "booked";
            save();
            log("call", `Booked ${service || "appointment"} for ${name} at ${startISO} via AI line`);
            // Fire-and-forget: never make the caller wait on SMS/email delivery.
            // notify.js already catches its own errors, this is just a safety net.
            notify.notifyBookingConfirmed({ name, phone, email: lead.email, service, startISO })
              .catch((e) => log("notify", `Booking confirmation error: ${e.message}`));
            results.push({ toolCallId: tc.id, result: `Booked — confirmed for ${startISO}.` });
          } else {
            results.push({ toolCallId: tc.id, result: "Sorry, I couldn't book that — the calendar isn't connected right now. A team member will confirm by phone." });
          }
        } else if (tc.name === "place_order") {
          // Canonical schema: instances/the-burg/VAPI-SETUP.md — customer_name,
          // phone, items:[{name,qty,modifiers}], notes, allergy (verbatim
          // allergy text, not a boolean). Restaurant-vertical only; Shine
          // Dental's assistant has no place_order tool, so this branch is
          // simply never reached for that instance.
          const { customer_name, phone, items: requestedItems, notes, allergy } = tc.arguments || {};
          const services = profile.services || [];
          const { matched, unmatched, prepMinutes } = orders.buildOrderItems(requestedItems, services);

          if (!matched.length) {
            results.push({
              toolCallId: tc.id,
              result: unmatched.length
                ? `I couldn't find ${unmatched.join(", ")} on our menu — could you pick something from the menu instead?`
                : "I didn't catch any items — what would you like to order?",
            });
            continue;
          }

          const existingOrder = db.orders.find((o) => o.vapiCallId === m.call?.id);
          let order;
          let orderChanged = false;
          if (existingOrder && orders.sameItems(existingOrder.items, matched)) {
            // exact retry of the same confirmed order — don't double it,
            // and don't re-fire the kitchen ticket / confirmation SMS
            order = existingOrder;
          } else if (existingOrder) {
            // a genuinely new/different item list on the same live call —
            // the only sensible read is the customer adding to their order
            existingOrder.items.push(...matched);
            existingOrder.total = orders.computeTotal(existingOrder.items);
            if (allergy) {
              existingOrder.allergyFlag = true;
              existingOrder.allergyNote = [existingOrder.allergyNote, allergy].filter(Boolean).join("; ");
            }
            if (notes) existingOrder.notes = [existingOrder.notes, notes].filter(Boolean).join(" · ");
            order = existingOrder;
            orderChanged = true;
          } else {
            const pickupISO = new Date(Date.now() + prepMinutes * 60000).toISOString();
            order = {
              id: "O" + Date.now(),
              ts: new Date().toISOString(),
              customer: { name: customer_name || m.customer?.name || "Unknown caller", phone: phone || m.customer?.number || "" },
              items: matched,
              notes: notes || "",
              allergyFlag: !!allergy,
              allergyNote: allergy || "",
              total: orders.computeTotal(matched),
              pickupTime: pickupISO,
              status: "new",
              vapiCallId: m.call?.id,
            };
            db.orders.unshift(order);
            orderChanged = true;
          }
          save();
          log("order", `${order.customer.name} placed an order — $${order.total.toFixed(2)}${order.allergyFlag ? " · ALLERGY: " + order.allergyNote : ""}`);

          // Fire-and-forget, same pattern as notifyBookingConfirmed — never
          // make the caller wait on ticket/SMS delivery. Only on a real
          // creation or addition, never on the exact-duplicate-retry no-op,
          // so the kitchen and the customer each get exactly one ticket/
          // text per real change, not one per retried tool call.
          if (orderChanged) {
            notify.sendKitchenTicket(order).catch((e) => log("notify", `Kitchen ticket error: ${e.message}`));
            notify.notifyOrderConfirmed(order).catch((e) => log("notify", `Order confirmation error: ${e.message}`));
          }

          const prepText = Math.round((new Date(order.pickupTime).getTime() - Date.now()) / 60000);
          const spoken = `Order in — $${order.total.toFixed(2)}, ready in about ${Math.max(prepText, 5)} minutes.` +
            (unmatched.length ? ` I couldn't find ${unmatched.join(", ")} on the menu, so I left that off.` : "");
          results.push({ toolCallId: tc.id, result: spoken });
        } else {
          results.push({ toolCallId: tc.id, result: "Unknown tool." });
        }
      } catch (e) {
        const label = tc.name === "book_appointment" ? "Error booking the appointment" : "Error checking the calendar";
        results.push({ toolCallId: tc.id, result: `${label}: ${e.message}` });
      }
    }
    return res.json({ results });
  }

  // Vapi sends many other message types during a live call (status-update,
  // transcript, speech-update, etc.) to the same Server URL — only an
  // actual end-of-call-report should create a call record. Anything else,
  // just acknowledge and ignore, otherwise every one of those turns into a
  // bogus "Call completed" row.
  if (m.type !== "end-of-call-report") {
    return res.json({ ok: true });
  }

  // end-of-call report → call record + booking
  const db = load();
  const analysis = m.analysis || {};
  const durationSeconds = m.durationSeconds ?? m.duration ??
    (m.startedAt && m.endedAt ? Math.round((new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 1000) : null);
  const call = {
    id: "C" + Date.now(),
    dir: m.call?.type === "outboundPhoneCall" ? "outbound" : "inbound",
    who: m.customer?.name || m.customer?.number || "Unknown caller",
    summary: analysis.summary || m.summary || "Call completed",
    outcome: analysis.structuredData?.outcome || "completed",
    ts: new Date().toISOString(),
    // Additive, defensively normalized like normalizeToolCall — Vapi's
    // exact field names/nesting vary by plan/version, and any of these can
    // legitimately be absent (e.g. recording disabled); null, never throw.
    recordingUrl: m.recordingUrl ?? m.artifact?.recordingUrl ?? null,
    transcript: m.transcript ?? m.artifact?.transcript ?? null,
    durationSeconds: typeof durationSeconds === "number" && !Number.isNaN(durationSeconds) ? durationSeconds : null,
  };
  db.calls.unshift(call);
  const leadId = m.call?.metadata?.leadId;
  if (leadId) {
    const lead = db.leads.find((l) => l.id === leadId);
    if (lead && call.outcome === "booked") lead.status = "booked";
    if (lead && call.outcome === "not_interested") lead.status = "closed_lost";
  }
  // Fallback booking path for calls that ended "booked" without a tool-call
  // (e.g. assistant fell back to describing a time in speech only). Skipped
  // when this call already booked for real via check_availability/book_appointment,
  // to avoid writing a duplicate appointment row for the same call.
  const alreadyBookedByTool = db.appointments.some((a) => a.vapiCallId === m.call?.id && a.googleEventId);
  if (call.outcome === "booked" && analysis.structuredData?.slot && !alreadyBookedByTool) {
    db.appointments.unshift({ id: "A" + Date.now(), time: analysis.structuredData.slot, name: call.who, service: analysis.structuredData.service || "", source: call.dir === "inbound" ? "AI line" : "Outbound", status: "unconfirmed", vapiCallId: m.call?.id });
  }

  // Coverage-gap learning: every question the receptionist couldn't answer
  // on a real call becomes a proposed faq_gap fact — same human-gated path
  // as every other memory fact (owner approves in the Memory tab, then
  // vapiSync pushes it into the live prompt). Requires the assistant's
  // analysisPlan.structuredDataSchema to declare unansweredQuestions (see
  // the comment in vapiSync.js) — silently a no-op array until that's
  // configured, never a crash.
  const rawUnanswered = Array.isArray(analysis.structuredData?.unansweredQuestions) ? analysis.structuredData.unansweredQuestions : [];
  // Exact-text dedup within this one call's own list first — isSameFact
  // below can't be used for that (its source-overlap signal assumes
  // "same caller/call = same fact re-described", which is backwards here:
  // every question from THIS call legitimately shares the same source
  // string, so comparing them against each other would wrongly collapse
  // genuinely different questions into one).
  const unanswered = [...new Set(rawUnanswered.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim()))];
  if (unanswered.length) {
    // Only compare against facts that existed BEFORE this call — real
    // duplicate detection across calls/time, not within this call's list.
    const priorFacts = db.memory.filter((f) => f.status === "proposed" || f.status === "approved");
    const source = `call · ${m.customer?.name || maskPhone(call.who)}`;
    let learned = 0;
    for (const q of unanswered) {
      const candidate = { type: "faq_gap", fact: q, source };
      if (priorFacts.some((e) => isSameFact(e, candidate))) continue;
      db.memory.push({ id: "M" + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), type: "faq_gap", fact: q, source, status: "proposed" });
      learned++;
    }
    if (learned) log("system", `Coverage gap: ${learned} unanswered question(s) from this call proposed for review`);
  }

  save();
  // call.who is a display name when Vapi has caller-ID data, otherwise it's
  // the raw phone number itself — mask only in that second case, since the
  // activity log (unlike the Calls tab) is visible to every authenticated
  // user, not just the owner.
  const whoForLog = m.customer?.name || maskPhone(call.who);
  log("call", `${call.dir === "inbound" ? "Inbound" : "Outbound"} · ${whoForLog}: ${call.summary}`);
  res.json({ ok: true });
});

// Meta Lead Ads: verification + lead payloads
app.get("/webhooks/meta", webhookLimiter, (req, res) => {
  if (req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN)
    return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhooks/meta", webhookLimiter, (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(403);
  const db = load();
  db.settings.lastWebhookAt = new Date().toISOString(); // heartbeat's "last webhook seen"
  let added = 0;
  for (const entry of req.body?.entry || []) {
    for (const ch of entry.changes || []) {
      const f = Object.fromEntries((ch.value?.field_data || []).map((x) => [x.name, x.values?.[0]]));
      if (!f.phone_number && !f.email) continue;
      const lead = { id: "L" + Date.now() + added, name: f.full_name || "Meta lead", phone: f.phone_number || "", email: f.email || "", source: "meta", service: f.service || "", status: "new", createdAt: new Date().toISOString() };
      db.leads.unshift(lead);
      leadQueue.maybeAutoQueueLead(db, lead);
      added++;
    }
  }
  save();
  if (added) log("lead", `${added} new Meta lead(s) received`);
  res.json({ ok: true });
});

// Google Ads lead form webhook
app.post("/webhooks/google", webhookLimiter, (req, res) => {
  if (process.env.GOOGLE_ADS_WEBHOOK_KEY && req.body?.google_key !== process.env.GOOGLE_ADS_WEBHOOK_KEY)
    return res.sendStatus(403);
  const db = load();
  db.settings.lastWebhookAt = new Date().toISOString(); // heartbeat's "last webhook seen"
  const cols = Object.fromEntries((req.body?.user_column_data || []).map((x) => [x.column_id, x.string_value]));
  const lead = { id: "L" + Date.now(), name: cols.FULL_NAME || "Google lead", phone: cols.PHONE_NUMBER || "", email: cols.EMAIL || "", source: "google", service: "", status: "new", createdAt: new Date().toISOString() };
  db.leads.unshift(lead);
  leadQueue.maybeAutoQueueLead(db, lead);
  save();
  log("lead", "New Google Ads lead received");
  res.json({ ok: true });
});

// RFP inbox: Resend's inbound-email webhook shape, or a plain
// {from,subject,text} JSON for a forwarded-mailbox setup (see
// rfp.js's normalizeEmailPayload for exactly how both are read). A
// malformed/unparseable email is logged and skipped, never a 500 — see
// rfp.js's processInboundRfp for the full reasoning.
app.post("/webhooks/email", webhookLimiter, async (req, res) => {
  if (process.env.RESEND_INBOUND_SECRET && req.headers["x-resend-secret"] !== process.env.RESEND_INBOUND_SECRET) {
    return res.sendStatus(403);
  }
  load().settings.lastWebhookAt = new Date().toISOString(); save(); // heartbeat's "last webhook seen"
  try {
    await rfp.processInboundRfp(req.body);
  } catch (e) {
    log("error", `RFP inbox error: ${e.message}`); // logged, never thrown up to the response
  }
  res.json({ ok: true });
});

app.post("/api/leads/:id/rfp/approve", auth, requireOwner, async (req, res) => {
  const result = await rfp.approveAndSend(req.params.id, req.user.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json(result.lead);
});

// ---------- scheduler ----------
let jobs = [];
function bootSchedules() {
  jobs.forEach((j) => j.stop());
  jobs = [];
  const db = load();
  // db.agents is a generic fixture row-per-runner; which of those runners
  // are actually schedulable now is the catalog's DB-backed active set
  // (server/catalog.js), not a static instance-boot-time list — this needs
  // to be re-derived on every call since activate/deactivate call this at
  // runtime, no redeploy. Only an agent that's both in the active set AND
  // currently toggled on gets a cron armed at all — a paused or
  // never-activated agent gets nothing scheduled, not even a no-op tick.
  const activeIds = new Set(catalog.getActiveAgentIds(db));
  const schedulableRunnerIds = new Set(
    Object.values(AGENTS).filter((a) => activeIds.has(a.id)).map((a) => catalog.runnerRowId(a))
  );
  for (const a of db.agents) {
    if (!schedulableRunnerIds.has(a.id)) continue;
    if (!a.on) continue;
    if (!cron.validate(a.schedule)) continue;
    jobs.push(
      cron.schedule(a.schedule, async () => {
        const fresh = load().agents.find((x) => x.id === a.id);
        if (!fresh?.on) return;
        try { await runAgent(a.id); } catch (e) { log("error", `${a.name} failed: ${e.message}`); }
      })
    );
  }
  console.log(`Scheduler: ${jobs.length} agent schedule(s) armed`);
}

// Daily appointment-reminder sweep — engine-level, not a brain/ agent (it
// has no on/off toggle or Claude call, just a plain notify.js send), so it
// runs on its own cron outside bootSchedules()'s per-agent loop. Runs at
// 9am in the clinic's own timezone regardless of where the server is hosted.
function bootReminderCron() {
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        const count = await notify.runDailyReminders();
        if (count) log("notify", `Reminder sweep: sent ${count} appointment reminder(s)`);
      } catch (e) { log("error", `Reminder cron failed: ${e.message}`); }
    },
    { timezone: calendarApi.tz() }
  );
}

// Nightly backup: gzip db.json onto the same volume, keep the last 14. Not
// offsite (see README) — this only protects against corruption/bad-deploy
// data loss, not a lost/destroyed Railway volume, but it's the floor every
// production instance should have.
const BACKUPS_DIR = path.join(path.dirname(DB_PATH), "backups");
function runBackup() {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const raw = fs.readFileSync(DB_PATH);
    const gz = zlib.gzipSync(raw);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(BACKUPS_DIR, `db-${stamp}.json.gz`), gz);
    const files = fs.readdirSync(BACKUPS_DIR).filter((f) => /^db-.*\.json\.gz$/.test(f)).sort();
    while (files.length > 14) fs.unlinkSync(path.join(BACKUPS_DIR, files.shift()));
    log("system", `Backup created (${Math.min(files.length, 14)} kept)`);
  } catch (e) {
    console.error("Backup failed:", e.message);
  }
}
function bootBackupCron() {
  cron.schedule("0 3 * * *", runBackup, { timezone: calendarApi.tz() });
}

// Weekly safety re-sync — catches drift (e.g. a manually-added fact whose
// debounced push got interrupted by a restart) even if no approval happens
// that week. Same syncToVapi() path as everything else; still respects
// VAPI_SYNC_DRY_RUN.
function bootVapiSyncCron() {
  cron.schedule(
    "0 18 * * 0",
    () => vapiSync.syncToVapi("weekly-cron").catch((e) => log("error", `Weekly Vapi sync failed: ${e.message}`)),
    { timezone: calendarApi.tz() }
  );
}

// Webhook secrets are optional-if-unset (an instance can come up before
// they're wired), but that should never be silent — a loud boot warning is
// the difference between "we forgot to set this" being caught in the
// deploy log versus discovered later as an incident.
function warnUnsetWebhookSecrets() {
  if (!process.env.VAPI_SERVER_SECRET) {
    console.warn("WARNING: VAPI_SERVER_SECRET is not set — /webhooks/vapi will accept requests from anyone. Set the same value as the Server URL secret in the Vapi assistant/phone number settings.");
  }
  if (!process.env.META_APP_SECRET) {
    console.warn("WARNING: META_APP_SECRET is not set — /webhooks/meta will accept unsigned lead payloads from anyone who finds the URL.");
  }
  if (!process.env.GOOGLE_ADS_WEBHOOK_KEY) {
    console.warn("WARNING: GOOGLE_ADS_WEBHOOK_KEY is not set — /webhooks/google will accept requests from anyone.");
  }
  if (!process.env.GOOGLE_CALENDAR_CREDENTIALS) {
    console.warn("WARNING: GOOGLE_CALENDAR_CREDENTIALS is not set — calendar features will run in local-only fallback mode.");
  }
  if (!vapiSync.hasVapiConfig()) {
    console.warn("NOTE: VAPI_API_KEY or VAPI_INBOUND_ASSISTANT_ID is not set — Vapi knowledge sync will no-op with a log line even if VAPI_SYNC_DRY_RUN=0.");
  } else if (vapiSync.isDryRun()) {
    console.log("Vapi knowledge sync is in DRY RUN mode (default) — composed prompts are logged, never pushed. Set VAPI_SYNC_DRY_RUN=0 to go live.");
  }
}

// Unauthed by design (for uptime monitors) — deliberately returns no data,
// just process/liveness signals.
const { version } = require("../package.json");
app.get("/api/health", (req, res) => {
  let dbWritable = true;
  try {
    fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK);
  } catch {
    dbWritable = false;
  }
  res.json({ ok: true, version, dbWritable });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic suite running → http://localhost:${PORT}`);
  bootSchedules();
  bootReminderCron();
  bootBackupCron();
  bootVapiSyncCron();
  warnUnsetWebhookSecrets();
  // Only HQ ever polls other deployments — a plain client instance just
  // answers /api/heartbeat requests and never calls startPolling() at all.
  if (SAILZ_ADMIN) hqClients.startPolling();
});
