require("dotenv").config();
const fs = require("fs");
const express = require("express");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cron = require("node-cron");
const { load, save, log, DB_PATH } = require("./store");
const { runAgent } = require("./agents");
const calendarApi = require("./calendar");

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
app.post("/api/claims/:id/approve", auth, (req, res) => {
  const db = load();
  const c = db.claims.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Claim not found" });
  c.status = "approved"; c.approvedBy = req.user.id; save();
  log("billing", `Claim ${c.id} approved — queued for clearinghouse submission`);
  res.json(c);
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
          const startISO = calendarApi.zonedTimeToISO(date, parsedTime.hh, parsedTime.mm, calendarApi.tz());
          const out = await calendarApi.bookAppointment({ name, phone, service, startISO, durationMinutes: calendarApi.serviceDurationMinutes(service) });
          if (out.eventId) {
            db.appointments.unshift({
              id: "A" + Date.now(), time: startISO, name, service, source: "AI line", status: "confirmed",
              googleEventId: out.eventId, vapiCallId: m.call?.id,
            });
            const lead = db.leads.find((l) => l.phone === phone);
            if (lead) lead.status = "booked";
            save();
            log("call", `Booked ${service || "appointment"} for ${name} at ${startISO} via AI line`);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic suite running → http://localhost:${PORT}`);
  bootSchedules();
});
