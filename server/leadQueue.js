// Speed-to-lead auto-queue guardrails. Every automated outbound contact
// this triggers still goes through the existing calling agent (setter())
// on its own schedule/cron — this module only decides whether a brand-new
// lead gets bumped to the front of that queue (priorityCall) or deferred
// to the next morning, never places a call itself.
const { log } = require("./store");
const { instance } = require("./instance");

const QUIET_START_HOUR = 8; // 8am
const QUIET_END_HOUR = 20; // 8pm — matches the hard constraint in the
// Lead Engine spec (8am-8pm local); the calling agent's OWN cron window
// (brain/agents/calling.md's schedule, currently 9-18) is a separate,
// narrower constraint that still applies on top of this — this function
// only governs whether a lead gets marked priorityCall=true right now,
// not whether a call can be physically placed this second.

function isQuietHours(date = new Date(), timeZone = instance.timezone || "America/New_York") {
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
  if (isQuietHours()) {
    lead.priorityCall = true;
    log("system", `${lead.name}: auto-queued for an immediate callback (inside quiet hours)`);
  } else {
    lead.priorityCall = false;
    lead.deferredMorning = true;
    log("system", `${lead.name}: outside quiet hours — queued for a morning callback`);
  }
}

module.exports = { isQuietHours, isDNC, addToDNC, maybeAutoQueueLead, QUIET_START_HOUR, QUIET_END_HOUR };
