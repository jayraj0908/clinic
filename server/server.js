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
const { runAgent } = require("./agents");
const calendarApi = require("./calendar");
const brainGraph = require("./brainGraph");
const notify = require("./notify");
const chat = require("./chat");
const { maskPhone, verifyMetaSignature } = require("./security");
const vapiSync = require("./vapiSync");

const NODE_ENV = process.env.NODE_ENV || "development";

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
  res.json({ token: jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" }), name: u.name });
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
  const user = { id: "u" + nanoid(10), email, passHash: bcrypt.hashSync(tempPassword, 10), name: email.split("@")[0], role: roleValue };
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
  save();
  log("system", `${u.email} changed their password`);
  res.json({ ok: true });
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
  if (m.type === "faq_gap" || m.type === "policy_correction") vapiSync.scheduleSyncDebounced(req.user.id);
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

  const proposedMemory = db.memory.filter((m) => m.status === "proposed");
  if (proposedMemory.length) {
    items.push({
      type: "memory_review", severity: "medium",
      title: `Brain learned ${proposedMemory.length} new thing${proposedMemory.length > 1 ? "s" : ""} — review`,
      detail: proposedMemory.slice(0, 3).map((m) => m.fact).join(" · ").slice(0, 160),
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
  const m = req.body?.message || req.body || {};

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
  let added = 0;
  for (const entry of req.body?.entry || []) {
    for (const ch of entry.changes || []) {
      const f = Object.fromEntries((ch.value?.field_data || []).map((x) => [x.name, x.values?.[0]]));
      if (!f.phone_number && !f.email) continue;
      db.leads.unshift({ id: "L" + Date.now() + added, name: f.full_name || "Meta lead", phone: f.phone_number || "", email: f.email || "", source: "meta", service: f.service || "", status: "new", createdAt: new Date().toISOString() });
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
  const cols = Object.fromEntries((req.body?.user_column_data || []).map((x) => [x.column_id, x.string_value]));
  db.leads.unshift({ id: "L" + Date.now(), name: cols.FULL_NAME || "Google lead", phone: cols.PHONE_NUMBER || "", email: cols.EMAIL || "", source: "google", service: "", status: "new", createdAt: new Date().toISOString() });
  save();
  log("lead", "New Google Ads lead received");
  res.json({ ok: true });
});

// ---------- scheduler ----------
let jobs = [];
function bootSchedules() {
  jobs.forEach((j) => j.stop());
  jobs = [];
  for (const a of load().agents) {
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
});
