// The agent catalog: brain/agents/*.md (+ instance overrides) is the FULL
// set of agents a client can ever see. Which of them are actually running
// is a separate, DB-backed, per-instance layer — this module is the one
// place that computes "what state is this agent in" and mutates that
// state. Nothing here talks HTTP; server.js's /api/catalog* routes are a
// thin wrapper.
const { AGENTS } = require("./brain");
const { instance } = require("./instance");

// Precedence for "which agents are active (or paused, i.e. known-about) for
// this instance": an explicit db.activeAgents array always wins once it
// exists (even if empty — that's a real "the owner turned everything off"
// state, not "unset"). Before the owner ever touches activation, fall back
// to instance.json's "agents" allowlist (The Burg's receptionist+librarian
// today), and before THAT existed, every catalog agent was implicitly
// active — the final fallback, so a pre-existing live deployment (Shine)
// that has never called activate/deactivate keeps behaving exactly as it
// did before this feature shipped.
function getActiveAgentIds(db) {
  if (Array.isArray(db.activeAgents)) return db.activeAgents;
  if (Array.isArray(instance.agents)) return instance.agents.filter((id) => AGENTS[id]);
  // dormantByDefault agents (brain.js) are excluded even from this
  // "implicit all-active" fallback — that fallback exists to preserve
  // the ORIGINAL roster's old always-on behavior on a deployment that's
  // never touched activate/deactivate, not to auto-activate an agent
  // that didn't exist when that history began.
  return Object.keys(AGENTS).filter((id) => !AGENTS[id].dormantByDefault);
}

// db.agents rows predate this feature and are keyed by an agent's `runner`
// id (e.g. leads.runner === "intake"), not the brain-agent id itself —
// preserved as-is so /api/agents/:id/toggle|run|schedule (existing routes,
// must stay unchanged) keep working untouched. Agents with no runner
// (receptionist) get a row keyed by their own id instead — new, purely
// additive, since no such row existed before.
function runnerRowId(agent) {
  return agent.runner != null ? agent.runner : agent.id;
}

function getAgentRow(db, agent) {
  return db.agents.find((a) => a.id === runnerRowId(agent));
}

// The actual effective secret value for an integration id — env wins when
// both exist. Used at the point of REAL use (an outbound fetch call), not
// just for the connected/not-connected state check below. Only meaningful
// for integrations that are a single string secret (anthropic, vapi,
// claimmd, meta, gads) — Twilio/Resend need a companion FROM address/
// number that a single {id,key} pair can't carry, and gcal is a whole
// service-account JSON blob, so those three stay env-configured only for
// actually sending; a db-stored key for them still flips their catalog
// "connected" display, which is honest (it IS a stored credential) even
// though notify.js won't use it to send until a same the FROM piece is
// also available some other way.
function resolveKey(db, integrationId) {
  const integ = db.integrations.find((i) => i.id === integrationId);
  const envVal = integ?.envKey && process.env[integ.envKey];
  if (envVal) return envVal;
  const keys = db.settings.integrationKeys || {};
  return keys[integrationId] || null;
}

// A requirement is satisfied by EITHER an env var OR a db-stored key —
// never neither. Env always wins when both exist (checked at the point of
// actual use, not here — this function only answers "is it connected".
function checkRequirements(db, agent) {
  const keys = db.settings.integrationKeys || {};
  const missing = [];
  for (const reqId of agent.requires) {
    const integ = db.integrations.find((i) => i.id === reqId);
    const hasEnv = !!(integ?.envKey && process.env[integ.envKey]);
    const hasDbKey = !!keys[reqId];
    if (!hasEnv && !hasDbKey) missing.push(reqId);
  }
  return { met: missing.length === 0, missing };
}

// active (on) · paused (activated, toggled off) · available (could
// activate right now) · needs_setup (missing a required integration).
function getAgentState(db, agent) {
  const activeIds = getActiveAgentIds(db);
  const { met, missing } = checkRequirements(db, agent);
  if (!activeIds.includes(agent.id)) {
    return { state: met ? "available" : "needs_setup", missing };
  }
  const row = getAgentRow(db, agent);
  const on = row ? !!row.on : true; // activated with no row yet (shouldn't normally happen) defaults to on
  return { state: on ? "active" : "paused", missing: [] };
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// Lightweight, generic "is this thing doing anything" signal for the
// catalog list view — agents.js's runAgent() logs "<displayName>: <result>"
// on every run, so counting activity lines with that prefix is a cheap,
// accurate-enough proxy without needing a new run-history table. Stage 4
// replaces this with real per-agent-type weekly stats in the detail panel;
// this stays as the catalog card's quick counter.
function weekRunCount(db, agent) {
  const since = Date.now() - SEVEN_DAYS;
  if (agent.id === "receptionist") {
    return db.calls.filter((c) => c.dir === "inbound" && new Date(c.ts).getTime() >= since).length;
  }
  const prefix = agent.displayName + ":";
  return db.activity.filter((a) => a.type === "agent" && a.message.startsWith(prefix) && new Date(a.ts).getTime() >= since).length;
}

function lastRunFor(db, agent) {
  const row = getAgentRow(db, agent);
  if (row?.lastRun) return row.lastRun;
  if (agent.id === "receptionist") {
    const lastCall = db.calls.find((c) => c.dir === "inbound");
    return lastCall?.ts || null;
  }
  return null;
}

function catalogEntry(db, agent) {
  const { state, missing } = getAgentState(db, agent);
  return {
    id: agent.id,
    name: agent.displayName,
    tagline: agent.tagline,
    description: agent.description,
    workflows: agent.workflows,
    results: agent.results,
    requires: agent.requires,
    color: agent.color,
    glyph: agent.glyph,
    order: agent.order,
    state,
    missing,
    runsThisWeek: weekRunCount(db, agent),
    lastRun: lastRunFor(db, agent),
  };
}

function getCatalog(db) {
  return Object.values(AGENTS)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((agent) => catalogEntry(db, agent));
}

function newAgentRow(agent, on) {
  return {
    id: runnerRowId(agent),
    name: agent.displayName,
    desc: agent.description,
    schedule: agent.schedule,
    scheduleLabel: agent.schedule || "",
    on,
    lastRun: null,
    lastResult: "",
    stat: "",
  };
}

// Promotes the current EFFECTIVE active set (which may only exist via the
// instance.json/all-catalog fallback, never yet written to the DB) into a
// real db.activeAgents array — called on the first activate/deactivate a
// given instance ever does, so flipping ONE agent doesn't silently drop
// every other implicitly-active one.
function materializeActiveSet(db) {
  if (!Array.isArray(db.activeAgents)) db.activeAgents = getActiveAgentIds(db);
  return db.activeAgents;
}

function activate(db, id) {
  const agent = AGENTS[id];
  if (!agent) return { ok: false, status: 404, error: "Unknown agent" };
  const { met, missing } = checkRequirements(db, agent);
  if (!met) return { ok: false, status: 400, error: "Missing required integrations", missing };
  const activeIds = materializeActiveSet(db);
  if (!activeIds.includes(id)) activeIds.push(id);
  const row = getAgentRow(db, agent);
  if (row) row.on = true;
  else db.agents.push(newAgentRow(agent, true));
  return { ok: true, agent: catalogEntry(db, agent) };
}

function deactivate(db, id) {
  const agent = AGENTS[id];
  if (!agent) return { ok: false, status: 404, error: "Unknown agent" };
  const activeIds = materializeActiveSet(db);
  if (!activeIds.includes(id)) activeIds.push(id); // stays "known" — pausing, not un-activating
  const row = getAgentRow(db, agent);
  if (row) row.on = false;
  else db.agents.push(newAgentRow(agent, false));
  return { ok: true, agent: catalogEntry(db, agent) };
}

module.exports = {
  getActiveAgentIds,
  runnerRowId,
  getAgentRow,
  checkRequirements,
  resolveKey,
  getAgentState,
  catalogEntry,
  getCatalog,
  activate,
  deactivate,
};
