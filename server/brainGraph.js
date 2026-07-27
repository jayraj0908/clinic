// Builds the "agent brain" graph (nodes/edges) and per-agent inspector detail
// from real data — no fake/padded entities. Five hubs map onto the real
// pipeline: Leads (intake agent), Receptionist (inbound Vapi line, not a
// cron agent — always-on), Calling (setter agent), Audit Notes (audit
// agent), Billing (billing agent).
const { load } = require("./store");

const HUBS = [
  { id: "leads", name: "Leads Agent", color: "#d4af37", glyph: "◈", tagline: "capture · qualify · route",
    workflows: ["Capture Meta Ads leads", "Capture Google Ads leads", "Qualify & route to Receptionist"],
    tools: ["meta", "gads"] },
  { id: "receptionist", name: "AI Receptionist", color: "#3a8c8c", glyph: "☎", tagline: "answer · book · confirm",
    workflows: ["Answer inbound calls", "Check calendar availability", "Book appointment", "Save contact to leads"],
    tools: ["vapi", "gcal", "anthropic"] },
  { id: "calling", name: "Calling Agent", color: "#a05a2c", glyph: "↪", tagline: "call · follow up · book",
    workflows: ["Call qualified leads", "Check calendar availability", "Book appointment"],
    tools: ["vapi", "gcal", "anthropic"], agentId: "setter" },
  { id: "audit", name: "Audit Notes Agent", color: "#6a5acd", glyph: "☷", tagline: "structure · SOAP · billing-ready",
    workflows: ["Structure visit notes into SOAP"],
    tools: ["anthropic"], agentId: "audit" },
  { id: "billing", name: "Billing Agent", color: "#b23333", glyph: "⧉", tagline: "code · claim · collect",
    workflows: ["Draft CPT/ICD claim codes", "Hold for owner approval"],
    tools: ["anthropic", "claimmd"], agentId: "billing" },
];
HUBS[0].agentId = "intake";

function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

function agentStatus(db, hub) {
  if (hub.id === "receptionist") {
    const connected = db.integrations.find((i) => i.id === "vapi" && (process.env[i.envKey] || i.status === "connected"));
    return connected ? "active" : "offline";
  }
  const a = db.agents.find((x) => x.id === hub.agentId);
  if (!a) return "offline";
  if (!a.on) return "idle";
  if (hub.id === "billing" && db.claims.some((c) => c.status === "awaiting_approval")) return "needs_review";
  if (hub.id === "audit" && db.visits.some((v) => !v.auditComplete)) return "needs_review";
  return "active";
}

function recentActivity(db, hubId) {
  if (hubId === "leads") {
    return db.leads.slice(0, 8).map((l) => ({ ts: l.createdAt, summary: `${l.name} — ${l.service || "inquiry"} (${l.source})`, status: l.status }));
  }
  if (hubId === "receptionist") {
    return db.calls.filter((c) => c.dir === "inbound").slice(0, 8).map((c) => ({ ts: c.ts, summary: c.summary, status: c.outcome }));
  }
  if (hubId === "calling") {
    return db.calls.filter((c) => c.dir === "outbound").slice(0, 8).map((c) => ({ ts: c.ts, summary: c.summary, status: c.outcome }));
  }
  if (hubId === "audit") {
    return db.visits.slice(0, 8).map((v) => ({ ts: v.ts, summary: `Visit ${v.id} — ${v.patient}`, status: v.auditComplete ? "audited" : "pending" }));
  }
  if (hubId === "billing") {
    return db.claims.slice(0, 8).map((c) => ({ id: c.id, ts: c.ts, summary: `Claim ${c.id} — ${(c.codes || []).map((x) => x.code || x).join(", ")} — $${c.amount ?? "?"}`, status: c.status }));
  }
  return [];
}

function todayStats(db, hubId) {
  const leadsToday = db.leads.filter((l) => isToday(l.createdAt));
  const callsToday = db.calls.filter((c) => isToday(c.ts));
  if (hubId === "leads") {
    return [
      { label: "Leads today", value: leadsToday.length },
      { label: "Qualified today", value: leadsToday.filter((l) => l.status !== "new").length },
      { label: "Sources connected", value: db.integrations.filter((i) => ["meta", "gads"].includes(i.id) && (process.env[i.envKey] || i.status === "connected")).length },
    ];
  }
  if (hubId === "receptionist") {
    const inboundToday = callsToday.filter((c) => c.dir === "inbound");
    return [
      { label: "Calls answered today", value: inboundToday.length },
      { label: "Booked today", value: inboundToday.filter((c) => c.outcome === "booked").length },
      { label: "Missed today", value: inboundToday.filter((c) => c.outcome === "missed").length },
    ];
  }
  if (hubId === "calling") {
    const outboundToday = callsToday.filter((c) => c.dir === "outbound");
    return [
      { label: "Calls placed today", value: outboundToday.length },
      { label: "Booked today", value: outboundToday.filter((c) => c.outcome === "booked").length },
      { label: "Leads waiting", value: db.leads.filter((l) => l.status === "qualified").length },
    ];
  }
  if (hubId === "audit") {
    return [
      { label: "Visits documented", value: db.visits.filter((v) => v.auditComplete).length },
      { label: "Pending review", value: db.visits.filter((v) => !v.auditComplete).length },
      { label: "Billing-ready", value: db.visits.filter((v) => v.billingReady).length },
    ];
  }
  if (hubId === "billing") {
    const approved = db.claims.filter((c) => c.status === "approved");
    return [
      { label: "Claims filed", value: db.claims.length },
      { label: "Awaiting approval", value: db.claims.filter((c) => c.status === "awaiting_approval").length },
      { label: "$ collected (approved)", value: "$" + approved.reduce((s, c) => s + (c.amount || 0), 0).toLocaleString() },
    ];
  }
  return [];
}

function buildGraph(db) {
  const nodes = [];
  const links = [];

  nodes.push({ id: "clinic", type: "clinic", name: db.settings.clinicName || "Clinic" });

  HUBS.forEach((hub) => {
    const status = agentStatus(db, hub);
    nodes.push({ id: hub.id, type: "agent", name: hub.name, color: hub.color, glyph: hub.glyph, tagline: hub.tagline, status });
    links.push({ source: "clinic", target: hub.id, kind: "spoke" });

    hub.workflows.forEach((w, i) => {
      const wid = `${hub.id}_wf_${i}`;
      nodes.push({ id: wid, type: "workflow", name: w, agent: hub.id });
      links.push({ source: hub.id, target: wid, kind: "orbit" });
    });

    hub.tools.forEach((toolId) => {
      const integ = db.integrations.find((i) => i.id === toolId);
      if (!integ) return;
      const nid = `tool_${toolId}`;
      if (!nodes.find((n) => n.id === nid)) {
        const connected = !!process.env[integ.envKey] || integ.status === "connected";
        nodes.push({ id: nid, type: "tool", name: integ.name, color: hub.color, connected });
      }
      links.push({ source: hub.id, target: nid, kind: "orbit" });
    });

    recentActivity(db, hub.id).forEach((ev, i) => {
      const eid = `${hub.id}_evt_${i}`;
      nodes.push({ id: eid, type: "event", agent: hub.id, color: hub.color });
      links.push({ source: hub.id, target: eid, kind: "dust" });
    });
  });

  // patient dust — names in db.leads are already first-name + last-initial,
  // no phone/PHI rendered on canvas
  db.leads.slice(0, 12).forEach((l) => {
    const pid = "patient_" + l.id;
    nodes.push({ id: pid, type: "patient", name: l.name });
    const owner = l.status === "booked" || l.status === "seen" ? "calling" : "leads";
    links.push({ source: owner, target: pid, kind: "orbit" });
  });

  // hand-off chain
  for (let i = 0; i < HUBS.length - 1; i++) {
    links.push({ source: HUBS[i].id, target: HUBS[i + 1].id, kind: "handoff" });
  }

  return {
    nodes, links,
    stats: {
      agents: HUBS.length,
      actionsThisWeek: db.calls.length + db.leads.length + db.claims.length + db.visits.length,
      connections: links.length,
    },
  };
}

function buildAgentDetail(db, hubId) {
  const hub = HUBS.find((h) => h.id === hubId);
  if (!hub) return null;
  const a = hub.agentId ? db.agents.find((x) => x.id === hub.agentId) : null;
  return {
    id: hub.id, name: hub.name, color: hub.color, glyph: hub.glyph, tagline: hub.tagline,
    agentId: hub.agentId || null,
    status: agentStatus(db, hub),
    lastRun: a ? a.lastRun : null,
    lastResult: a ? a.lastResult : null,
    workflows: hub.workflows,
    tools: hub.tools.map((tid) => db.integrations.find((i) => i.id === tid)).filter(Boolean)
      .map((i) => ({ name: i.name, connected: !!process.env[i.envKey] || i.status === "connected" })),
    todayStats: todayStats(db, hub.id),
    recentActivity: recentActivity(db, hub.id),
  };
}

module.exports = { buildGraph, buildAgentDetail, HUBS };
