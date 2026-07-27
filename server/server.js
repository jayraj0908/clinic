require("dotenv").config();
const fs = require("fs");
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const cron = require("node-cron");
const { load, save, log, DB_PATH } = require("./store");
const { runAgent } = require("./agents");
const calendarApi = require("./calendar");
const brainGraph = require("./brainGraph");
const notify = require("./notify");
const chat = require("./chat");

// First boot (e.g. a fresh Railway deploy with no persistent volume yet):
// seed so the owner login exists. Skipped whenever a database already
// exists, so a restart/redeploy never wipes real accumulated data.
if (!fs.existsSync(DB_PATH)) {
  console.log("No database found — running first-time seed...");
  require("./seed");
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// ---------- auth ----------
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = load().users.find((x) => x.email === email);
  if (!u || !bcrypt.compareSync(password || "", u.passHash))
    return res.status(401).json({ error: "Invalid email or password" });
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
    activity: db.activity.slice(0, 20),
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
    const reply = await chat.runChat(messages);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- webhooks (no auth; verify per-provider signatures in prod) ----------

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
app.post("/webhooks/vapi", async (req, res) => {
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
          log("lead", `${lead.name} (${lead.phone}) called in${service ? " about " + service : ""} — saved to leads`);
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
  const call = {
    id: "C" + Date.now(),
    dir: m.call?.type === "outboundPhoneCall" ? "outbound" : "inbound",
    who: m.customer?.name || m.customer?.number || "Unknown caller",
    summary: analysis.summary || m.summary || "Call completed",
    outcome: analysis.structuredData?.outcome || "completed",
    ts: new Date().toISOString(),
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
  log("call", `${call.dir === "inbound" ? "Inbound" : "Outbound"} · ${call.who}: ${call.summary}`);
  res.json({ ok: true });
});

// Meta Lead Ads: verification + lead payloads
app.get("/webhooks/meta", (req, res) => {
  if (req.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN)
    return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhooks/meta", (req, res) => {
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
app.post("/webhooks/google", (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic suite running → http://localhost:${PORT}`);
  bootSchedules();
  bootReminderCron();
});
