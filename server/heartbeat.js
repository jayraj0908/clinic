// Cross-instance health signal — HQ polls GET /api/heartbeat on every
// client deployment to build the client board (server/hqClients.js,
// Stage 4's admin console). Deliberately NO PHI: counts and states only,
// never names/phones/emails/transcripts/addresses. Gated by a shared
// secret header (x-sailz-hq-key matching this deployment's own
// HEARTBEAT_KEY env), not a JWT login — this is service-to-service, not
// a user action, and every deployment (including plain clients) responds
// to it, not just HQ.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { load, DB_PATH } = require("./store");
const { instance } = require("./instance");
const catalog = require("./catalog");

// Railway sets this automatically on every deploy; falls back to reading
// git directly (local/other hosts), then to null rather than throwing —
// version reporting is a nice-to-have, never worth crashing boot over.
let GIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || null;
if (!GIT_SHA) {
  try {
    GIT_SHA = execSync("git rev-parse HEAD", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    GIT_SHA = null;
  }
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
function countSince(arr, tsField) {
  const since = Date.now() - SEVEN_DAYS;
  return (arr || []).filter((x) => {
    const t = new Date(x[tsField]).getTime();
    return !Number.isNaN(t) && t >= since;
  }).length;
}

// Same check /api/health already uses — reused, not reinvented.
function dbWritable() {
  try {
    fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function buildSnapshot() {
  const db = load();
  const activeAgents = catalog.getCatalog(db).filter((a) => a.state === "active").map((a) => a.id);
  const lastAgentRun = (db.agents || []).reduce((max, a) => (a.lastRun && (!max || a.lastRun > max) ? a.lastRun : max), null);
  // Appointment rows have no createdAt field today — "time" is the
  // appointment's own scheduled slot, so this counts what's on the books
  // for the coming 7 days (upcoming), not appointments BOOKED in the last
  // 7 days, unlike calls/orders/leads below which do measure that from
  // their own ts/createdAt fields. Documented here so a future reader of
  // the client board isn't misled by the field name alone.
  const apptsUpcoming = (db.appointments || []).filter((a) => {
    const t = new Date(a.time).getTime();
    return !Number.isNaN(t) && t >= Date.now() && t <= Date.now() + SEVEN_DAYS;
  }).length;
  return {
    id: instance.id,
    name: instance.name,
    version: GIT_SHA,
    counts: {
      callsThisWeek: countSince(db.calls, "ts"),
      ordersThisWeek: countSince(db.orders, "ts"),
      leadsThisWeek: countSince(db.leads, "createdAt"),
      apptsUpcomingThisWeek: apptsUpcoming,
      // Outbound Lead Engine dialer — counts only, no PHI (no names/phones/
      // transcripts), matching this whole snapshot's own rule.
      dialerAttemptsThisWeek: countSince(db.dialerAttempts, "ts"),
      dialerLeadsQueued: (db.leads || []).filter((l) => l.dialerState === "queued").length,
      dialerLeadsExhausted: (db.leads || []).filter((l) => l.dialerState === "exhausted").length,
    },
    activeAgents,
    health: {
      dbWritable: dbWritable(),
      lastWebhookAt: db.settings.lastWebhookAt || null,
      lastAgentRun,
    },
    ts: new Date().toISOString(),
  };
}

module.exports = { buildSnapshot };
