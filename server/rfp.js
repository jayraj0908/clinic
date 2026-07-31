// RFP inbox agent — the hotel/events wedge. An inbound email (forwarded
// from a client's rfp@ mailbox, or Resend's inbound webhook) becomes a
// parsed lead with a drafted response, waiting for one owner click to
// send. See clients/myrtle-beach-hotels.md for the product rationale:
// nobody can identify a Google searcher, but an RFP inbox replied to in
// minutes instead of the industry's ~48h wins deals on speed alone.
const { load, save, log } = require("./store");
const { profile, instance } = require("./instance");
const { claude } = require("./agents");
const { maybeAutoQueueLead } = require("./leadQueue");

// Resend's inbound-email webhook payload shape (data.from/subject/text)
// vs. a plain forwarded-mailbox setup ({from, subject, text} directly) —
// normalized here so the rest of this module never cares which arrived.
// Shaped from Resend's documented inbound webhook pattern, not yet
// exercised against a live Resend inbound route in this repo — same
// caveat every other "implemented from docs, not yet live-tested"
// integration in this codebase already carries (vapiSync.js, the Vapi
// tool schemas). Confirm the exact field names against Resend's current
// docs before relying on this for a real client.
function normalizeEmailPayload(body) {
  const d = body?.data || body || {};
  const from = d.from?.email || d.from || body?.from || "";
  const subject = d.subject || body?.subject || "";
  const text = d.text || d.html || body?.text || "";
  return { from: String(from || "").trim(), subject: String(subject || "").trim(), text: String(text || "").trim() };
}

function renderSpacesKnowledge() {
  if (!profile.services?.length) return "No spaces/services listed in the profile yet.";
  return profile.services.map((s) => {
    const detail = [s.price, s.duration].filter(Boolean).join(", ");
    return `- ${s.name}${detail ? " — " + detail : ""}`;
  }).join("\n");
}

// Claude extraction — strict JSON, defensively parsed. Returns null (not
// a throw) on anything malformed so the webhook handler can log-and-skip
// exactly like every other defensively-parsed inbound payload in this
// codebase (normalizeToolCall, the Vapi handlers).
async function extractRfpDetails(db, email) {
  const out = await claude(
    db,
    `Extract event-RFP details from this email. Output STRICT JSON only, no prose:\n` +
      `{"eventDate":"...","headcount":"...","budgetHints":"...","spaceNeeds":"...","contactName":"...","contactEmail":"...","contactPhone":"...","deadline":"..."}\n` +
      `Use "" for any field not present — never invent a value. Email:\n\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.text}`,
    "You extract structured facts from event-planning RFP emails. Output strict JSON only — no markdown fences, no commentary. Never fabricate a field that isn't in the source text."
  );
  if (!out) return null;
  try {
    const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function draftResponse(db, email, details) {
  const out = await claude(
    db,
    `Draft a warm, specific, fast reply to this event-planning RFP, from ${instance.name || "our venue"}. ` +
      `Reference only real spaces/rates from the list below — never invent capacity or pricing not listed. ` +
      `If something they asked isn't in the list, say we'll confirm it, don't guess. Keep it tight — a busy planner reads this in 20 seconds.\n\n` +
      `THEIR REQUEST:\nEvent date: ${details.eventDate || "not specified"}\nHeadcount: ${details.headcount || "not specified"}\nBudget hints: ${details.budgetHints || "not specified"}\nSpace needs: ${details.spaceNeeds || "not specified"}\n\n` +
      `OUR REAL SPACES/RATES:\n${renderSpacesKnowledge()}\n\n` +
      `Output STRICT JSON only: {"subject":"...","body":"..."} — body is plain text, no HTML.`,
    "You draft fast, honest, specific RFP responses for a real venue. Never invent capacity, pricing, or availability. Output strict JSON only."
  );
  if (!out) return null;
  try {
    const parsed = JSON.parse(out.replace(/```json|```/g, "").trim());
    return parsed?.subject && parsed?.body ? parsed : null;
  } catch {
    return null;
  }
}

// Returns the created lead, or null if the email was too malformed to
// even attempt (logged either way — never throws up to the webhook).
async function processInboundRfp(rawBody) {
  const email = normalizeEmailPayload(rawBody);
  if (!email.from && !email.text) {
    log("system", "RFP inbox: received an email with no sender and no body — skipped");
    return null;
  }
  const db = load();
  const details = await extractRfpDetails(db, email);
  if (!details) {
    log("system", `RFP inbox: couldn't parse an RFP out of the email from ${email.from || "unknown sender"} — skipped, not lost (check the raw inbox)`);
    return null;
  }
  const draft = await draftResponse(db, email, details);

  const receivedAt = new Date().toISOString();
  const lead = {
    id: "L" + Date.now(),
    name: details.contactName || email.from || "RFP contact",
    phone: details.contactPhone || "",
    email: details.contactEmail || email.from || "",
    source: "rfp",
    type: "rfp",
    service: details.spaceNeeds || "",
    status: "new",
    createdAt: receivedAt,
    rfp: {
      eventDate: details.eventDate || "",
      headcount: details.headcount || "",
      budgetHints: details.budgetHints || "",
      spaceNeeds: details.spaceNeeds || "",
      deadline: details.deadline || "",
      receivedAt,
      draftSubject: draft?.subject || "",
      draftBody: draft?.body || "",
      status: draft ? "awaiting_approval" : "draft_failed",
    },
  };
  db.leads.unshift(lead);
  maybeAutoQueueLead(db, lead);
  save();
  log("lead", `RFP from ${lead.name} received${draft ? " — response drafted, awaiting approval" : " — draft failed, needs a manual reply"}`);
  return lead;
}

// POST /api/leads/:id/rfp/approve — sends the drafted reply and records
// the received→sent elapsed time, the metric the whole feature sells.
async function approveAndSend(leadId, approvedBy) {
  const db = load();
  const lead = db.leads.find((l) => l.id === leadId);
  if (!lead || !lead.rfp) return { ok: false, status: 404, error: "RFP lead not found" };
  if (lead.rfp.status === "sent") return { ok: false, status: 400, error: "Already sent" };
  if (!lead.email) return { ok: false, status: 400, error: "No email address on file for this lead" };

  const notify = require("./notify"); // required here, not top-level, to avoid a require cycle (notify.js doesn't need rfp.js, but keeps this module's own dependency surface obvious)
  const result = await notify.sendEmail(lead.email, lead.rfp.draftSubject || "Re: your event inquiry", (lead.rfp.draftBody || "").replace(/\n/g, "<br>"));
  if (!result.sent) return { ok: false, status: 502, error: result.reason || "Send failed" };

  const sentAt = new Date().toISOString();
  const elapsedMinutes = Math.max(0, Math.round((new Date(sentAt).getTime() - new Date(lead.rfp.receivedAt).getTime()) / 60000));
  lead.rfp.status = "sent";
  lead.rfp.sentAt = sentAt;
  lead.rfp.elapsedMinutes = elapsedMinutes;
  save();
  log("lead", `RFP response sent to ${lead.name} by ${approvedBy} — responded in ${elapsedMinutes}m`);
  return { ok: true, lead };
}

module.exports = { processInboundRfp, approveAndSend, normalizeEmailPayload };
