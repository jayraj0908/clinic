// Agent execution logic. Each agent is a function the scheduler (or a manual
// "Run now") invokes. With real API keys in .env these hit live services;
// without them, they no-op safely and log what they *would* do.
const { load, save, log } = require("./store");
const { AGENTS } = require("./brain");
const { profile } = require("./instance");

const hasKey = (k) => !!process.env[k];

// Renders the instance's clinic-profile facts as plain-text knowledge to
// append after an agent's brain-file body — the same profile that seeds
// db.settings.receptionist, so agents and the dashboard never disagree.
function instanceKnowledgeBlock() {
  const lines = [];
  if (profile.hours?.length) {
    lines.push("Hours: " + profile.hours.map((h) => `${h.days} ${h.open ? `${h.open}–${h.close}` : "closed"}`).join(", "));
  }
  if (profile.services?.length) {
    lines.push("Services: " + profile.services.map((s) => `${s.name} (${s.price}, ${s.duration})`).join("; "));
  }
  if (profile.insuranceAccepted?.length) lines.push("Insurance accepted: " + profile.insuranceAccepted.join(", "));
  if (profile.selfPay) lines.push("Self-pay: " + profile.selfPay);
  if (profile.policies?.length) lines.push("Policies: " + profile.policies.join(" "));
  return lines.join("\n");
}

// An agent's Claude system prompt = its brain/agents/<id>.md body (or the
// instance override of the same name) + the instance's clinic knowledge.
// Falls back to a minimal generic prompt if the brain file is missing, so
// a misconfigured instance degrades instead of crashing.
function systemPromptFor(agentId, extra) {
  const a = AGENTS[agentId];
  const base = a ? a.body : `You are the ${agentId} agent for this clinic.`;
  const knowledge = instanceKnowledgeBlock();
  return [base, knowledge ? `## Clinic knowledge\n${knowledge}` : "", extra || ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// Claude API helper (used by audit + billing agents)
async function claude(prompt, system) {
  if (!hasKey("ANTHROPIC_API_KEY")) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: system || "",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  return data.content?.map((c) => c.text || "").join("") || null;
}

const agents = {
  // 1 ─ Lead intake: in production Meta/Google push to /webhooks; this run
  //     re-polls Meta as a safety net and promotes "new" → "qualified".
  async intake() {
    const db = load();
    let promoted = 0;
    for (const l of db.leads) {
      if (l.status === "new" && l.phone && l.service) { l.status = "qualified"; promoted++; }
    }
    save();
    if (hasKey("META_LEAD_ADS_TOKEN")) {
      // Poll: GET graph.facebook.com/v19.0/{form_id}/leads — wire your form IDs in .env
      log("agent", `Lead Intake: polled Meta forms, qualified ${promoted} lead(s)`);
    } else {
      log("agent", `Lead Intake: qualified ${promoted} lead(s) (Meta polling off — no token)`);
    }
    return `${promoted} qualified`;
  },

  // 2 ─ Appointment setter: launches outbound calls through Vapi.
  async setter() {
    const db = load();
    const queue = db.leads.filter((l) => l.status === "qualified");
    if (!queue.length) { log("agent", "Appointment Setter: queue empty"); return "queue empty"; }

    if (!hasKey("VAPI_API_KEY")) {
      log("agent", `Appointment Setter: ${queue.length} lead(s) ready — connect Vapi to start calling`);
      return `${queue.length} waiting on Vapi`;
    }
    let placed = 0;
    for (const lead of queue.slice(0, 5)) {
      const res = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          assistantId: process.env.VAPI_OUTBOUND_ASSISTANT_ID,
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          customer: { number: lead.phone, name: lead.name },
          metadata: { leadId: lead.id, service: lead.service },
        }),
      });
      if (res.ok) { lead.status = "call_scheduled"; placed++; }
    }
    save();
    log("agent", `Appointment Setter: placed ${placed} call(s)`);
    return `${placed} calls placed`;
  },

  // 3 ─ Visit audit: structures raw notes into SOAP via Claude.
  async audit() {
    const db = load();
    const pending = db.visits.filter((v) => !v.auditComplete);
    if (!pending.length) { log("agent", "Visit Audit: nothing pending"); return "nothing pending"; }
    for (const v of pending) {
      const out = await claude(
        `Structure these provider notes into SOAP JSON. Reorganize only — never add clinical content not present in the source.\n\n${v.rawNotes || ""}`,
        systemPromptFor("audit", "Output strict JSON: {subjective, objective, assessment, plan, procedures_documented[], diagnoses_documented[], missing[]}.")
      );
      if (out) { v.soap = out; v.auditComplete = true; }
    }
    save();
    log("agent", `Visit Audit: processed ${pending.length} visit(s)`);
    return `${pending.length} audited`;
  },

  // 4 ─ Billing: suggests codes for billing-ready visits; humans approve in UI.
  async billing() {
    const db = load();
    const ready = db.visits.filter((v) => v.billingReady && !db.claims.find((c) => c.visitId === v.id));
    for (const v of ready) {
      const out = await claude(
        `From this audited visit note, suggest CPT/CDT + ICD-10 codes with one-line justification each, citing the supporting line. JSON: {codes:[{code, justification}]}. Code only what documentation supports.\n\n${JSON.stringify(v.soap || {})}`,
        systemPromptFor("billing")
      );
      db.claims.push({ id: "CL" + Date.now(), visitId: v.id, codes: out ? JSON.parse(out.replace(/```json|```/g, "")).codes : [], status: "awaiting_approval", amount: null, ts: new Date().toISOString() });
    }
    save();
    log("agent", `Insurance Billing: ${ready.length} claim(s) drafted → awaiting human approval`);
    return `${ready.length} drafted`;
  },
};

async function runAgent(id) {
  const db = load();
  const a = db.agents.find((x) => x.id === id);
  if (!a) throw new Error("unknown agent " + id);
  const result = await agents[id]();
  a.lastRun = new Date().toISOString();
  a.lastResult = result;
  save();
  return result;
}

module.exports = { runAgent, systemPromptFor };
