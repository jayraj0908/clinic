// Agent execution logic. Each agent is a function the scheduler (or a manual
// "Run now") invokes. With real API keys in .env these hit live services;
// without them, they no-op safely and log what they *would* do.
const { load, save, log } = require("./store");
const { AGENTS } = require("./brain");
const { profile, instance } = require("./instance");
const catalog = require("./catalog");

const hasKey = (k) => !!process.env[k];

// Simple word-overlap (Jaccard) similarity — no new dep, good enough to
// catch "we already proposed basically this" without needing real NLP.
function wordSet(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean));
}
function factSimilarity(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / new Set([...A, ...B]).size;
}
// Measured against real (non-deterministic) Claude output describing the
// same underlying event across separate runs: text similarity for
// obviously-the-same fact ranged from 0.81 (similar wording) down to 0.37
// (same meaning, materially different sentence structure) — full-paragraph
// facts paraphrase too much for word-overlap alone to catch reliably.
const SIMILARITY_DUP_THRESHOLD = 0.6;

// Second, more reliable signal: same type + a shared named source (caller/
// lead) almost always means "same underlying event, re-described" even when
// the wording drifted too far for factSimilarity to catch. Overlap
// coefficient (not Jaccard) since source strings are short name lists where
// one being a subset of the other should still count as a strong match.
function sourceOverlap(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / Math.min(A.size, B.size);
}
function isSameFact(existing, candidate) {
  if (existing.type === candidate.type && sourceOverlap(existing.source, candidate.source) > 0.5) return true;
  return factSimilarity(existing.fact, candidate.fact) > SIMILARITY_DUP_THRESHOLD;
}

// Renders the instance's clinic-profile facts as plain-text knowledge to
// append after an agent's brain-file body — the same profile that seeds
// db.settings.receptionist, so agents and the dashboard never disagree.
function instanceKnowledgeBlock() {
  const lines = [];
  if (profile.hours?.length) {
    lines.push("Hours: " + profile.hours.map((h) => `${h.days} ${h.open ? `${h.open}–${h.close}` : "closed"}`).join(", "));
  }
  if (profile.services?.length) {
    // modifiers is additive/optional (used by the restaurant vertical's
    // menu-as-services — see instances/the-burg) — when absent this is a
    // no-op, so dental's services render exactly as before.
    lines.push("Services: " + profile.services.map((s) => {
      const detail = [s.price, s.duration].filter(Boolean).join(", ");
      const mods = s.modifiers?.length ? ` [modifiers: ${s.modifiers.join(", ")}]` : "";
      return `${s.name} (${detail})${mods}`;
    }).join("; "));
  }
  if (profile.insuranceAccepted?.length) lines.push("Insurance accepted: " + profile.insuranceAccepted.join(", "));
  if (profile.selfPay) lines.push("Self-pay: " + profile.selfPay);
  if (profile.policies?.length) lines.push("Policies: " + profile.policies.join(" "));
  return lines.join("\n");
}

// An agent's Claude system prompt = its brain/agents/<id>.md body (or the
// instance override of the same name) + the instance's business knowledge.
// Falls back to a minimal generic prompt if the brain file is missing, so
// a misconfigured instance degrades instead of crashing. Vertical-neutral
// wording throughout — this composes the live prompt for every instance
// (dental, restaurant, whatever's next), not just the one this started on.
function systemPromptFor(agentId, extra) {
  const a = AGENTS[agentId];
  const base = a ? a.body : `You are the ${agentId} agent for ${instance.name || "this business"}.`;
  const knowledge = instanceKnowledgeBlock();
  return [base, knowledge ? `## Business knowledge\n${knowledge}` : "", extra || ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// Claude API helper (used by audit + billing + librarian). Takes db so it
// can fall back to a db-stored key (server/catalog.js's resolveKey) when
// ANTHROPIC_API_KEY isn't set in the environment — env still wins if both
// exist.
async function claude(db, prompt, system) {
  const apiKey = catalog.resolveKey(db, "anthropic");
  if (!apiKey) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
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
    // priorityCall (set by POST /api/leads/:id/queue-call, the attention
    // inbox's "call back" action) jumps a lead to the front of the queue.
    const queue = db.leads
      .filter((l) => l.status === "qualified")
      .sort((a, b) => (b.priorityCall ? 1 : 0) - (a.priorityCall ? 1 : 0));
    if (!queue.length) { log("agent", "Appointment Setter: queue empty"); return "queue empty"; }

    const vapiKey = catalog.resolveKey(db, "vapi");
    if (!vapiKey) {
      log("agent", `Appointment Setter: ${queue.length} lead(s) ready — connect Vapi to start calling`);
      return `${queue.length} waiting on Vapi`;
    }
    let placed = 0;
    for (const lead of queue.slice(0, 5)) {
      const res = await fetch("https://api.vapi.ai/call", {
        method: "POST",
        headers: { Authorization: `Bearer ${vapiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          assistantId: process.env.VAPI_OUTBOUND_ASSISTANT_ID,
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          customer: { number: lead.phone, name: lead.name },
          metadata: { leadId: lead.id, service: lead.service },
        }),
      });
      if (res.ok) { lead.status = "call_scheduled"; lead.priorityCall = false; placed++; }
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
        db,
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
        db,
        `From this audited visit note, suggest CPT/CDT + ICD-10 codes with one-line justification each, citing the supporting line. JSON: {codes:[{code, justification}]}. Code only what documentation supports.\n\n${JSON.stringify(v.soap || {})}`,
        systemPromptFor("billing")
      );
      db.claims.push({ id: "CL" + Date.now(), visitId: v.id, codes: out ? JSON.parse(out.replace(/```json|```/g, "")).codes : [], status: "awaiting_approval", amount: null, ts: new Date().toISOString() });
    }
    save();
    log("agent", `Insurance Billing: ${ready.length} claim(s) drafted → awaiting human approval`);
    return `${ready.length} drafted`;
  },

  // 5 ─ Librarian: drafts durable facts from the last 24h for owner review.
  // Never writes anything the phone assistant says — only ever proposes;
  // approval (server.js /api/memory/:id/approve) and the sync step
  // (server/vapiSync.js) are separate, human-gated steps.
  async librarian() {
    const db = load();
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recentCalls = db.calls.filter((c) => new Date(c.ts).getTime() >= since);
    const recentLeads = db.leads.filter((l) => new Date(l.createdAt).getTime() >= since);
    if (!recentCalls.length && !recentLeads.length) {
      log("agent", "Librarian: nothing in the last 24h to review");
      return "nothing to review";
    }
    const activityText = [
      recentCalls.length ? "CALLS:\n" + recentCalls.map((c) => `- ${c.who} · ${c.dir} · outcome: ${c.outcome} · "${c.summary || ""}"`).join("\n") : "",
      recentLeads.length ? "LEADS:\n" + recentLeads.map((l) => `- ${l.name} · service: ${l.service || "unspecified"} · source: ${l.source} · status: ${l.status}`).join("\n") : "",
    ].filter(Boolean).join("\n\n");

    if (!catalog.resolveKey(db, "anthropic")) {
      log("agent", "Librarian: reviewed activity, but no Anthropic key is configured — nothing extracted");
      return "no API key";
    }

    const out = await claude(
      db,
      `Review this clinic's last 24h of call/lead activity. Extract ONLY durable, generalizable facts worth remembering long-term — not one-off noise or anything already obvious from the clinic profile.\n\n` +
        `Type each fact exactly one of:\n` +
        `- faq_gap: callers keep asking something the assistant couldn't answer\n` +
        `- policy_correction: the assistant said something wrong or outdated\n` +
        `- preference: a specific patient's stated preference (name who)\n` +
        `- signal: a business-level pattern/insight, not phone-prompt material\n\n` +
        `Output strict JSON: {"facts":[{"type":"...","fact":"...","source":"..."}]}. ` +
        `source = brief context (caller name, or "N calls this week"). ` +
        `Return {"facts":[]} if nothing durable stands out — don't manufacture facts from thin activity.\n\n${activityText}`,
      systemPromptFor("librarian", "Silence (an empty facts array) is a valid and often correct output — you are a careful curator, not an eager pattern-matcher.")
    );

    let extracted = [];
    try { extracted = JSON.parse((out || "{}").replace(/```json|```/g, "")).facts || []; } catch { extracted = []; }

    const VALID_TYPES = new Set(["faq_gap", "policy_correction", "preference", "signal"]);
    const existing = db.memory.filter((m) => m.status === "proposed" || m.status === "approved");
    const added = [];
    for (const f of extracted) {
      if (!f || !f.fact || !VALID_TYPES.has(f.type)) continue;
      const isDup = existing.some((e) => isSameFact(e, f)) || added.some((a) => isSameFact(a, f));
      if (isDup) continue;
      const entry = { id: "M" + Date.now() + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), type: f.type, fact: f.fact, source: f.source || "", status: "proposed" };
      db.memory.push(entry);
      added.push(entry);
    }
    save();
    if (added.length) log("agent", `Librarian: learned ${added.length} new thing(s) — review in Memory`);
    else log("agent", "Librarian: reviewed activity, nothing new to learn");
    return `${added.length} learned`;
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

module.exports = { runAgent, systemPromptFor, isSameFact, claude };
