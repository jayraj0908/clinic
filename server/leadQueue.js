// Speed-to-lead auto-queue guardrails. Every automated outbound contact
// this triggers goes through server/dialer.js's tick() — the only
// calling path in this engine (agents.js's setter() is deprecated as of
// 2026-08-04, kept only as a no-op) — this module only decides whether a
// brand-new lead gets bumped to the front of that queue (priorityCall) or
// deferred to the next morning, never places a call itself.
const { log } = require("./store");
const { instance } = require("./instance");

const QUIET_START_HOUR = 8; // 8am
const QUIET_END_HOUR = 20; // 8pm — matches the hard constraint in the
// Lead Engine spec (8am-8pm local); the calling agent's OWN cron window
// (brain/agents/calling.md's schedule, currently 9-18) is a separate,
// narrower constraint that still applies on top of this — this function
// only governs whether a lead gets marked priorityCall=true right now,
// not whether a call can be physically placed this second.

// Named for what it returns, not the constant it's built from: TRUE means
// "within the allowed 8am-8pm calling window right now" (i.e. safe/legal
// to call), the opposite of what "isQuietHours" would suggest in plain
// English. Renamed from isQuietHours 2026-08-04 after that name caused a
// real confusion — a caller elsewhere had it backwards in a log message
// (said "inside quiet hours" for a call that was actually happening
// because it was NOT quiet hours). QUIET_START_HOUR/QUIET_END_HOUR keep
// their names since the CONSTANTS genuinely mark the boundary of the
// quiet period — it's only the boolean's direction that was confusing.
function isWithinCallingHours(date = new Date(), timeZone = instance.timezone || "America/New_York") {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(date));
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

// db.dnc: array of phone strings the owner has marked do-not-call —
// compared digit-only so formatting differences ("555-1234" vs
// "5551234") don't create a false negative.
function isDNC(db, phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return false;
  return (db.dnc || []).some((n) => String(n).replace(/\D/g, "") === digits);
}

// Permanent, cross-batch — a number added here is never re-eligible for
// outbound calling again, even from a future, completely separate import
// batch (server/dialer.js checks isDNC before ever dialing; server/
// leadImport.js doesn't check it at import time since DNC is an outbound-
// calling guardrail, not an import-eligibility one — a DNC contact can
// still be imported as a record, it just never gets called).
function addToDNC(db, phone) {
  if (!phone || isDNC(db, phone)) return;
  db.dnc.push(phone);
}

// Called right after a genuinely NEW lead is created, from an
// asynchronous source (webhook or RFP) where nobody is already talking
// to the person — never from a live-call flow (save_contact/
// book_appointment), where the receptionist just spoke to them this
// instant and an immediate outbound callback would be redundant, not
// helpful. Mutates the lead in place; caller still owns save().
function maybeAutoQueueLead(db, lead) {
  if (!lead.phone) return;
  if (!db.settings.autoCallNewLeads) return;
  if (isDNC(db, lead.phone)) {
    log("system", `${lead.name}: on the do-not-call list — not auto-queued for a callback`);
    return;
  }
  const callingRow = db.agents.find((a) => a.id === "setter");
  if (!callingRow || !callingRow.on) return; // calling agent must be active, per spec

  if (lead.status === "new") lead.status = "qualified";
  // This lead reached out to US first (a web form, an RFP email) — that
  // inbound contact is its consent basis for a prompt callback, checked
  // by server/dialer.js's hasConsentBasis() before it's ever dialed.
  // Stamped here (the moment it becomes dialer-eligible) rather than at
  // creation, so any lead that predates this field still gets one the
  // first time it's actually queued for a call.
  if (!lead.consentBasis) lead.consentBasis = "inbound_inquiry";
  if (isWithinCallingHours()) {
    lead.priorityCall = true;
    log("system", `${lead.name}: auto-queued for an immediate callback`);
  } else {
    lead.priorityCall = false;
    lead.deferredMorning = true;
    log("system", `${lead.name}: outside calling hours — queued for a morning callback`);
  }
}

module.exports = { isWithinCallingHours, isDNC, addToDNC, maybeAutoQueueLead, QUIET_START_HOUR, QUIET_END_HOUR };
