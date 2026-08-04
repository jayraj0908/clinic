// The paced outbound dialer for bulk-imported lead batches (server/
// leadImport.js). Deliberately separate from agents.js's setter() — that
// cron keeps handling real-time, one-at-a-time "qualified" leads from
// inbound sources (webhooks/RFPs) on its own 2-hour schedule, exactly as
// before; this module ONLY ever picks up leads with a batchId (i.e.
// imported campaign contacts), on its own much-tighter interval, because
// hour/concurrency pacing can't be enforced on a 2-hour cron.
//
// Everything here is server-enforced, not prompt-enforced: pacing caps,
// quiet hours, attempt caps, and DNC are all checked in code before a call
// is ever placed — the calling agent's own prompt (brain/agents/calling.md
// or an instance override) still carries the guardrail in words too, but
// this module is the one that can't be talked out of it.
const { load, save, log } = require("./store");
const { instance } = require("./instance");
const catalog = require("./catalog");
const leadQueue = require("./leadQueue");

const PACING_DEFAULTS = { maxConcurrent: 1, maxPerHour: 10, maxAttempts: 3, retrySpacingHours: 24 };
// Hard ceilings — what's stored in db.settings.dialerPacing (owner-edited,
// see server.js's /api/dialer/pacing route) is clamped through these on
// every read, not just on write, so a hand-edited db.json or an old value
// from before a ceiling was lowered can never exceed it either.
const PACING_MAX = { maxConcurrent: 3, maxPerHour: 30, maxAttempts: 5, retrySpacingHours: 168 };
const PACING_MIN = { maxConcurrent: 1, maxPerHour: 1, maxAttempts: 1, retrySpacingHours: 1 };

function clamp(n, lo, hi, fallback) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(num)));
}

function getPacing(db) {
  const stored = db.settings.dialerPacing || {};
  return {
    maxConcurrent: clamp(stored.maxConcurrent, PACING_MIN.maxConcurrent, PACING_MAX.maxConcurrent, PACING_DEFAULTS.maxConcurrent),
    maxPerHour: clamp(stored.maxPerHour, PACING_MIN.maxPerHour, PACING_MAX.maxPerHour, PACING_DEFAULTS.maxPerHour),
    maxAttempts: clamp(stored.maxAttempts, PACING_MIN.maxAttempts, PACING_MAX.maxAttempts, PACING_DEFAULTS.maxAttempts),
    retrySpacingHours: clamp(stored.retrySpacingHours, PACING_MIN.retrySpacingHours, PACING_MAX.retrySpacingHours, PACING_DEFAULTS.retrySpacingHours),
  };
}

// Owner-facing setter — always re-clamps before storing, so what's saved
// is already the effective value (no surprise silent clamping discovered
// only later at call time).
function setPacing(db, patch) {
  const current = getPacing(db);
  const next = {
    maxConcurrent: clamp(patch.maxConcurrent, PACING_MIN.maxConcurrent, PACING_MAX.maxConcurrent, current.maxConcurrent),
    maxPerHour: clamp(patch.maxPerHour, PACING_MIN.maxPerHour, PACING_MAX.maxPerHour, current.maxPerHour),
    maxAttempts: clamp(patch.maxAttempts, PACING_MIN.maxAttempts, PACING_MAX.maxAttempts, current.maxAttempts),
    retrySpacingHours: clamp(patch.retrySpacingHours, PACING_MIN.retrySpacingHours, PACING_MAX.retrySpacingHours, current.retrySpacingHours),
  };
  db.settings.dialerPacing = next;
  return next;
}

function isWeekendInTZ(date, timeZone) {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(date);
  return wd === "Sat" || wd === "Sun";
}

// "Next business day" = now + the configured spacing, then pushed forward
// (never back) past any weekend day in the CONTACT's own timezone — a
// Friday-afternoon no-answer with the default 24h spacing lands on
// Saturday by the clock, which this bumps to Monday instead.
function nextBusinessDay(fromDate, timeZone, retrySpacingHours) {
  let d = new Date(fromDate.getTime() + retrySpacingHours * 3600 * 1000);
  let guard = 0;
  while (isWeekendInTZ(d, timeZone) && guard < 7) {
    d = new Date(d.getTime() + 24 * 3600 * 1000);
    guard++;
  }
  return d;
}

function attemptsInLastHour(db) {
  const since = Date.now() - 3600 * 1000;
  return (db.dialerAttempts || []).filter((a) => new Date(a.ts).getTime() >= since).length;
}
function recordAttempt(db, leadId) {
  db.dialerAttempts.push({ ts: new Date().toISOString(), leadId });
  // Pruned to the last 24h on every write — only the last-hour window is
  // ever queried, so nothing older is worth keeping.
  const since = Date.now() - 24 * 3600 * 1000;
  db.dialerAttempts = db.dialerAttempts.filter((a) => new Date(a.ts).getTime() >= since);
}

// A call placed but never resolved (Vapi's end-of-call-report webhook
// lost, delayed, or never fired) would otherwise sit in "calling" forever,
// permanently occupying a concurrency slot. Treated exactly like a
// no_answer once it's been stuck this long — same retry/exhaust logic,
// via the same applyOutcome() the real webhook uses.
const STUCK_CALL_TIMEOUT_MS = 10 * 60 * 1000;
function reclaimStuckCalls(db) {
  const now = Date.now();
  let reclaimed = 0;
  db.leads.forEach((l) => {
    if (l.dialerState === "calling" && l.lastAttemptAt && now - new Date(l.lastAttemptAt).getTime() > STUCK_CALL_TIMEOUT_MS) {
      applyOutcome(db, l, "no_answer");
      reclaimed++;
    }
  });
  if (reclaimed) log("system", `Dialer: reclaimed ${reclaimed} stuck call(s) with no end-of-call report`);
}

// The single source of truth for "what does this outcome mean for this
// lead" — called both from the real Vapi end-of-call-report webhook
// (server.js) and from reclaimStuckCalls above, so there is exactly one
// place this logic can drift.
//
// booked/declined/do_not_call update lead.status (the existing pipeline
// vocabulary every lead already uses) for ANY lead, batch or not — DNC in
// particular must be universal, not just a dialer-batch concept, since
// "do not call me" can happen on any call, inbound or outbound. The
// dialer-specific state machine (dialerState/attempts/nextAttemptAt) only
// applies to leads that actually came from an import batch — a plain
// webhook-sourced "qualified" lead the OLD setter() cron calls doesn't
// carry those fields at all, and shouldn't start growing them here.
function applyOutcome(db, lead, outcome, extra = {}) {
  if (outcome === "booked") {
    lead.status = "booked";
    if (lead.batchId) lead.dialerState = "booked";
    return;
  }
  if (outcome === "not_interested" || outcome === "declined") {
    lead.status = "closed_lost";
    if (lead.batchId) lead.dialerState = "declined";
    return;
  }
  if (outcome === "do_not_call") {
    leadQueue.addToDNC(db, lead.phone);
    lead.status = "closed_lost";
    if (lead.batchId) lead.dialerState = "dnc";
    log("system", `${lead.name}: asked not to be called — added to the do-not-call list permanently`);
    return;
  }
  if (!lead.batchId) return; // retry scheduling is a dialer-batch-only concept

  const pacing = getPacing(db);
  const tz = lead.timezone || instance.timezone;
  if (outcome === "callback_requested") {
    lead.dialerState = "queued";
    const requested = extra.callbackTime ? new Date(extra.callbackTime) : null;
    lead.nextAttemptAt = requested && !Number.isNaN(requested.getTime()) && requested.getTime() > Date.now()
      ? requested.toISOString()
      : nextBusinessDay(new Date(), tz, pacing.retrySpacingHours).toISOString();
    return;
  }
  // no_answer / voicemail / any other non-terminal outcome — a failed
  // attempt. lead.attempts was already incremented at dial time, so this
  // check is "has THIS attempt (the one that just ended) used up the cap".
  if (lead.attempts >= pacing.maxAttempts) {
    lead.dialerState = "exhausted";
  } else {
    lead.dialerState = "queued";
    lead.nextAttemptAt = nextBusinessDay(new Date(), tz, pacing.retrySpacingHours).toISOString();
  }
  if (outcome === "voicemail") lead.voicemailLeft = true;
}

// Best-effort scripted voicemail for a lead's first attempt only — kept
// for whenever this gets properly wired (see the CONFIRMED BUG note in
// placeCall() below), so the wording exists in one place, not lost.
function firstAttemptVoicemailScript() {
  return `Hi, this is ${instance.name}. We tried to reach you — call us back whenever works, or we'll try again soon. Thanks!`;
}

async function placeCall(db, lead, vapiKey) {
  const body = {
    assistantId: process.env.VAPI_OUTBOUND_ASSISTANT_ID,
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    customer: { number: lead.phone, name: lead.name },
    metadata: { leadId: lead.id, batchId: lead.batchId },
  };
  // CONFIRMED BUG, fixed 2026-08-03: a top-level `voicemailMessage` field
  // is not a real field in Vapi's current call-creation schema — Vapi
  // rejects the ENTIRE request with 400 ("property voicemailMessage
  // should not exist") whenever it's present. Since every brand-new lead
  // is a first attempt, this silently broke 100% of outbound dialing on
  // Retirement Plan Resource Group's real deployment — placeCall() just
  // returned false on every single call, with the lead sitting at
  // dialerState "queued" forever and nothing logged anywhere. Removed
  // outright rather than guessing at the correct nested location — the
  // custom first-attempt voicemail message is off until someone verifies
  // the real field against Vapi's current docs and re-adds it properly
  // (with a live test call, not another guess).

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${vapiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return false;

  lead.dialerState = "calling";
  lead.attempts += 1;
  lead.lastAttemptAt = new Date().toISOString();
  lead.status = "call_scheduled";
  if (!lead.firstContactAt) lead.firstContactAt = new Date().toISOString();
  recordAttempt(db, lead.id);
  log("agent", `Dialer: calling ${lead.name} (attempt ${lead.attempts}/${getPacing(db).maxAttempts})`);
  return true;
}

// One tick = at most one call placed. Ticks run frequently (server.js's
// bootDialerLoop, ~every 30s) so the effective pacing over an hour is a
// smooth trickle toward maxPerHour, not a burst — and so pausing the
// calling agent takes effect within one tick, always: the very first
// thing every tick does is re-read the agent's on/off row fresh from disk
// and bail immediately if it's off, exactly like bootSchedules()'s cron
// jobs already do for every other agent.
async function tick() {
  const db = load();
  const settRow = db.agents.find((a) => a.id === "setter");
  if (!settRow || !settRow.on) return;

  reclaimStuckCalls(db);

  const pacing = getPacing(db);
  const inFlight = db.leads.filter((l) => l.dialerState === "calling").length;
  if (inFlight >= pacing.maxConcurrent) { save(); return; }
  if (attemptsInLastHour(db) >= pacing.maxPerHour) { save(); return; }

  const vapiKey = catalog.resolveKey(db, "vapi");
  if (!vapiKey) { save(); return; } // graceful no-op, same as setter()

  const now = Date.now();
  const eligible = db.leads
    .filter((l) => l.batchId && l.dialerState === "queued" && (!l.nextAttemptAt || new Date(l.nextAttemptAt).getTime() <= now))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Per-lead quiet hours (contact-local if this lead has a timezone from
  // import, else instance-local) — a lead outside its own calling window
  // right now is skipped in favor of the next eligible one, rather than
  // blocking the whole tick on one lead in a different timezone.
  const lead = eligible.find((l) => leadQueue.isQuietHours(new Date(), l.timezone || instance.timezone));
  if (!lead) { save(); return; }

  try {
    const placed = await placeCall(db, lead, vapiKey);
    if (!placed) log("error", `Dialer: Vapi rejected the call-creation request for ${lead.name} — check server logs/Vapi dashboard for the real reason (not retried automatically).`);
  } catch (e) {
    log("error", `Dialer: call to ${lead.name} failed to place: ${e.message}`);
  }
  save();
}

module.exports = {
  tick,
  applyOutcome,
  getPacing,
  setPacing,
  nextBusinessDay,
  PACING_MIN,
  PACING_MAX,
};
