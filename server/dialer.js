// The paced outbound dialer — the ONE and ONLY system that ever places a
// real outbound call in this engine. Historically agents.js's setter()
// cron was a second, parallel calling path for non-batch "qualified"
// leads; as of 2026-08-04 that path is fully retired (see agents.js's
// own setter() — it no longer calls anyone, just logs and returns) and
// every outbound call, batch-imported or not, test or real, goes through
// placeCallForLead() below. This is a hard architectural rule, not a
// convention: a second calling path means two independent systems that
// could both try to call the same person, which is exactly the bug this
// consolidation closes.
//
// Everything here is server-enforced, not prompt-enforced: pacing caps,
// calling-hours, attempt caps, DNC, and consent are all checked in code
// before a call is ever placed — the calling agent's own prompt (brain/
// agents/calling.md or an instance override) still carries the guardrail
// in words too, but this module is the one that can't be talked out of it.
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
      // applyOutcome's retry/exhaust logic only applies to leads dialer.js
      // actually owns a state machine for (batchId or test) — a one-off
      // individual lead (webhook/RFP-sourced, no retry campaign by
      // design, matching the retired setter()'s original one-attempt
      // behavior) has no terminal state to fall into there, and would
      // otherwise sit at "calling" forever, permanently occupying a
      // concurrency slot. Give it one directly.
      if (!l.batchId && !l.test && l.dialerState === "calling") l.dialerState = "no_answer";
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
// vocabulary every lead already uses) for ANY lead — DNC in particular
// must be universal, not just a dialer-batch concept, since "do not call
// me" can happen on any call, inbound or outbound. The dialer-specific
// state machine (dialerState/attempts/nextAttemptAt) only applies to
// leads dialer.js actually owns (batchId or test leads) — a plain
// webhook-sourced "qualified" lead never carries those fields at all and
// shouldn't start growing them here.
function applyOutcome(db, lead, outcome, extra = {}) {
  if (outcome === "booked") {
    lead.status = "booked";
    if (lead.batchId || lead.test) lead.dialerState = "booked";
    return;
  }
  if (outcome === "not_interested" || outcome === "declined") {
    lead.status = "closed_lost";
    if (lead.batchId || lead.test) lead.dialerState = "declined";
    return;
  }
  if (outcome === "do_not_call") {
    leadQueue.addToDNC(db, lead.phone);
    lead.status = "closed_lost";
    if (lead.batchId || lead.test) lead.dialerState = "dnc";
    log("system", `${lead.name}: asked not to be called — added to the do-not-call list permanently`);
    return;
  }
  if (!lead.batchId && !lead.test) return; // retry scheduling is a dialer-owned-lead-only concept

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
// placeCallForLead() below), so the wording exists in one place, not lost.
function firstAttemptVoicemailScript() {
  return `Hi, this is ${instance.name}. We tried to reach you — call us back whenever works, or we'll try again soon. Thanks!`;
}

// A lead is only ever callable with a real basis for having consented to
// be contacted. Batch-imported leads already passed the attestation gate
// at import time (server/leadImport.js requires attest="1" — the owner
// confirming every contact in the batch is an existing client or gave
// prior consent) — that IS their consent basis, so a batchId alone still
// satisfies this for leads imported before the explicit field existed.
// Anything else (test calls, any future non-batch entry point) must set
// lead.consentBasis explicitly — no implicit consent for those.
function hasConsentBasis(lead) {
  return !!(lead.consentBasis || lead.batchId);
}

// The single call-placement path — every guard a real outbound call must
// pass, then the actual Vapi request, for exactly one lead. Used by
// tick() below (the real paced batch/priority queue) AND directly by
// server.js's POST /api/dialer/test-call and POST /api/leads/:id/
// queue-call (immediate, synchronous feedback for an owner-initiated
// call) — same function, same guards, same assistant, so a manual call
// proves exactly what an automated one would do.
//
// Deliberately does NOT check the calling agent's on/off row — that
// switch pauses the AUTOMATED dialer loop (tick(), below) specifically;
// a human explicitly pressing "call this person now" or placing a test
// call is a separate, deliberate action and must still go through, same
// as a car's manual override isn't disabled by cruise control being off.
// Every REAL safety guardrail (pacing, DNC, consent, calling-hours)
// still applies regardless — this only affects the automation switch.
//
// Returns { ok:true, vapiCallId } or { ok:false, reason, detail? } —
// never throws for an expected refusal (pacing/DNC/consent/hours/
// Vapi-rejected); only a genuine network/unexpected error throws, left
// for the caller to catch.
async function placeCallForLead(db, lead) {
  const pacing = getPacing(db);
  const inFlight = db.leads.filter((l) => l.dialerState === "calling").length;
  if (inFlight >= pacing.maxConcurrent) return { ok: false, reason: "concurrency_limit" };
  if (attemptsInLastHour(db) >= pacing.maxPerHour) return { ok: false, reason: "hourly_cap" };

  const vapiKey = catalog.resolveKey(db, "vapi");
  if (!vapiKey) return { ok: false, reason: "vapi_not_configured" };

  if (leadQueue.isDNC(db, lead.phone)) return { ok: false, reason: "dnc" };
  // Set only by server/research.js's HQ lead sourcing, for a number no
  // phone-type lookup could positively confirm as a business landline —
  // never set by any other lead source, so this is a no-op for every
  // client instance. No override, no manual bypass: a wrongly-called
  // mobile number is a TCPA exposure, not just a bad lead.
  if (lead.notDialable) return { ok: false, reason: "not_dialable", detail: lead.notDialableReason };
  if (!hasConsentBasis(lead)) return { ok: false, reason: "no_consent_basis" };
  if (!leadQueue.isWithinCallingHours(new Date(), lead.timezone || instance.timezone)) return { ok: false, reason: "outside_calling_hours" };

  const body = {
    assistantId: process.env.VAPI_OUTBOUND_ASSISTANT_ID,
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    customer: { number: lead.phone, name: lead.name },
    metadata: { leadId: lead.id, batchId: lead.batchId, test: !!lead.test },
  };
  // CONFIRMED BUG, fixed 2026-08-03: a top-level `voicemailMessage` field
  // is not a real field in Vapi's current call-creation schema — Vapi
  // rejects the ENTIRE request with 400 ("property voicemailMessage
  // should not exist") whenever it's present. Removed outright rather
  // than guessing at the correct nested location — the custom
  // first-attempt voicemail message is off until someone verifies the
  // real field against Vapi's current docs and re-adds it properly.

  const res = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: { Authorization: `Bearer ${vapiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, reason: "vapi_rejected", detail: detail.slice(0, 500) };
  }
  const data = await res.json().catch(() => ({}));

  lead.dialerState = "calling";
  // Individual (webhook/RFP-sourced) leads never had attempts/dialerState
  // initialized before reaching this function — defensively default
  // rather than let `undefined + 1` produce NaN.
  lead.attempts = (Number.isFinite(lead.attempts) ? lead.attempts : 0) + 1;
  lead.lastAttemptAt = new Date().toISOString();
  lead.status = "call_scheduled";
  lead.priorityCall = false;
  if (!lead.firstContactAt) lead.firstContactAt = new Date().toISOString();
  recordAttempt(db, lead.id);
  log("agent", `Dialer: calling ${lead.name} (attempt ${lead.attempts}/${pacing.maxAttempts})${lead.test ? " [TEST]" : ""}`);
  return { ok: true, vapiCallId: data.id };
}

// One tick = at most one call placed. Ticks run frequently (server.js's
// bootDialerLoop, ~every 30s) so the effective pacing over an hour is a
// smooth trickle toward maxPerHour, not a burst — and so pausing the
// calling agent takes effect within one tick, always: the on/off row is
// read fresh from disk first thing, every tick. This check lives HERE,
// not in placeCallForLead() — it gates the AUTOMATED loop only; a manual
// test call or "Call now" press still works while paused (see
// placeCallForLead's own header comment for why).
async function tick() {
  const db = load();
  const settRow = db.agents.find((a) => a.id === "setter");
  if (!settRow || !settRow.on) return;

  reclaimStuckCalls(db);

  const now = Date.now();
  // Three lead pools, all owned by this one loop (the only calling path
  // in the engine):
  //  - batch: CSV-imported campaign contacts, full retry/pacing state
  //    machine via dialerState/attempts (RPRG's primary lead source).
  //  - test: one-off test calls from /api/dialer/test-call — same
  //    dialerState tracking as a batch lead, just no batchId.
  //  - individual: webhook/RFP-sourced leads auto-queued by
  //    leadQueue.js's maybeAutoQueueLead() (Shine/Burg's speed-to-lead
  //    feature) or manually prioritized via the leads tab's "Call"
  //    button — these never get a dialerState until picked up here, so
  //    they're matched by status==="qualified" instead; applyOutcome()
  //    intentionally does no retry scheduling for this pool (one attempt
  //    only, matching the retired setter()'s original behavior).
  // priorityCall (set by the "call" button, the attention inbox's "call
  // back" action, auto-queue, and always true for a freshly-created test
  // call) jumps a lead to the front of the queue.
  const isBatchOrTestQueued = (l) => (l.batchId || l.test) && l.dialerState === "queued" && (!l.nextAttemptAt || new Date(l.nextAttemptAt).getTime() <= now);
  const isIndividualQualified = (l) => !l.batchId && !l.test && l.status === "qualified" && !l.dialerState;
  const eligible = db.leads
    .filter((l) => isBatchOrTestQueued(l) || isIndividualQualified(l))
    .sort((a, b) => (b.priorityCall ? 1 : 0) - (a.priorityCall ? 1 : 0) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const lead of eligible) {
    let result;
    try {
      result = await placeCallForLead(db, lead);
    } catch (e) {
      log("error", `Dialer: call to ${lead.name} failed to place: ${e.message}`);
      continue;
    }
    if (result.ok) break; // one call per tick, done
    if (result.reason === "vapi_rejected") {
      log("error", `Dialer: Vapi rejected the call-creation request for ${lead.name}: ${result.detail || "no detail"} — not retried automatically.`);
      continue; // this lead's request was bad; another lead's might not be
    }
    if (result.reason === "dnc" || result.reason === "no_consent_basis" || result.reason === "outside_calling_hours") continue; // try the next lead
    break; // tick-level blocker (paused/concurrency/hourly cap/no vapi key) — no point trying other leads this tick
  }
  save();
}

module.exports = {
  tick,
  placeCallForLead,
  hasConsentBasis,
  applyOutcome,
  getPacing,
  setPacing,
  nextBusinessDay,
  firstAttemptVoicemailScript,
  PACING_MIN,
  PACING_MAX,
};
