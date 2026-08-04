// Builds the "agent brain" graph (nodes/edges) and per-agent inspector detail
// from real data — no fake/padded entities. Hubs come from brain/agents/*.md
// (Stage 2 of the engine/instance refactor) instead of a hardcoded array, so
// a new agent file is all it takes for a new node to appear on the map.
//
// CATALOG_HUBS is the FULL set (every agent that exists for this instance,
// active or not) — buildAgentDetail works against it so the panel opens for
// a dormant agent too. buildGraph only turns ACTIVE+PAUSED ones (server/
// catalog.js's getActiveAgentIds) into real map nodes; the frontend layers
// in dormant hubs itself from GET /api/catalog (Stage 3).
const { load } = require("./store");
const { AGENTS } = require("./brain");
const { instance } = require("./instance");
const catalog = require("./catalog");

function buildHubs() {
  return Object.values(AGENTS)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      name: a.displayName,
      color: a.color,
      glyph: a.glyph,
      tagline: a.tagline,
      workflows: a.workflows,
      tools: a.tools,
      agentId: a.runner, // db.agents id this hub's status/stats are read from (null = event-driven, no cron entry)
      handoff: a.handoff, // explicit frontmatter handoff targets, if any
    }));
}

const CATALOG_HUBS = buildHubs();

function activeHubs(db) {
  const activeIds = new Set(catalog.getActiveAgentIds(db));
  return CATALOG_HUBS.filter((h) => activeIds.has(h.id));
}

function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

function agentStatus(db, hub) {
  const agent = AGENTS[hub.id];
  const { state } = catalog.getAgentState(db, agent);
  if (state === "paused") return "idle";
  if (state !== "active") return "offline"; // available/needs_setup — shouldn't normally reach here (dormant hubs aren't in buildGraph's node list), kept as a safe fallback
  if (hub.id === "billing" && db.claims.some((c) => c.status === "awaiting_approval")) return "needs_review";
  if (hub.id === "audit" && db.visits.some((v) => !v.auditComplete)) return "needs_review";
  return "active";
}

function recentActivity(db, hubId) {
  if (hubId === "leads") {
    return db.leads.slice(0, 8).map((l) => ({ ts: l.createdAt, summary: `${l.name} — ${l.service || "inquiry"} (${l.source})`, status: l.status }));
  }
  if (hubId === "receptionist") {
    // Restaurant vertical: orders feed the same receptionist node's
    // activity alongside calls, the way visits feed audit and claims feed
    // billing. Additive/inert for Shine Dental — db.orders is always empty
    // there, so this merge is a no-op and the feed is exactly what it was.
    const callEvents = db.calls.filter((c) => c.dir === "inbound").map((c) => ({ ts: c.ts, summary: c.summary, status: c.outcome }));
    const orderEvents = (db.orders || []).map((o) => ({
      ts: o.ts,
      summary: `Order — ${o.customer.name || "unknown"} — $${o.total.toFixed(2)}${o.allergyFlag ? " · ALLERGY" : ""}`,
      status: o.status,
    }));
    return [...callEvents, ...orderEvents].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 8);
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

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
function inLastWeek(ts) {
  return new Date(ts).getTime() >= Date.now() - SEVEN_DAYS_MS;
}

// The Lead Engine's headline metric: median minutes from a lead landing
// (createdAt) to the calling agent's first outbound attempt
// (firstContactAt, set in server/agents.js's setter()). Target on the
// panel is "< 5 min" — median (not mean) so one lead that sat because
// Vapi wasn't configured doesn't blow up the number for everyone else.
function medianSpeedToLead(db) {
  const minutes = (db.leads || [])
    .filter((l) => l.firstContactAt && inLastWeek(l.createdAt))
    .map((l) => (new Date(l.firstContactAt).getTime() - new Date(l.createdAt).getTime()) / 60000)
    .filter((m) => m >= 0)
    .sort((a, b) => a - b);
  if (!minutes.length) return "no data yet";
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  return `${Math.round(median)} min`;
}

// The catalog agent panel's "Results this week" strip — one real,
// per-agent-type metric set, computed here (not the frontend) so the same
// numbers are trustworthy wherever they're shown. Every branch returns
// [{label, value}], same shape as todayStats above, just windowed to 7
// days and framed around what the OWNER cares about seeing happen, not
// internal agent mechanics.
function weekStats(db, hubId) {
  if (hubId === "leads") {
    const leadsWeek = db.leads.filter((l) => inLastWeek(l.createdAt));
    const bySource = {};
    leadsWeek.forEach((l) => { const s = l.source || "unknown"; bySource[s] = (bySource[s] || 0) + 1; });
    const topSources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s} (${n})`).join(", ");
    return [
      { label: "Leads captured this week", value: leadsWeek.length },
      { label: "By source", value: topSources || "none yet" },
    ];
  }
  if (hubId === "receptionist") {
    const inboundWeek = db.calls.filter((c) => c.dir === "inbound" && inLastWeek(c.ts));
    return [
      { label: "Calls answered this week", value: inboundWeek.length },
      { label: "Booked this week", value: inboundWeek.filter((c) => c.outcome === "booked").length },
    ];
  }
  if (hubId === "calling") {
    // The scoreboard IS the sell here — every number a client evaluating
    // the outbound Lead Engine actually cares about, front and center.
    // test:true calls (from /api/dialer/test-call) are deliberately
    // excluded — they're the owner poking at their own agent, not real
    // outbound performance, and would silently inflate/deflate the book
    // rate otherwise.
    const outboundWeek = db.calls.filter((c) => c.dir === "outbound" && !c.test && inLastWeek(c.ts));
    const booked = outboundWeek.filter((c) => c.outcome === "booked").length;
    // A "connect" = a live human actually picked up — everything except
    // no_answer/voicemail (which never reached a person) counts, including
    // the generic "completed" fallback outcome.
    const connects = outboundWeek.filter((c) => c.outcome !== "no_answer" && c.outcome !== "voicemail").length;
    const bookRate = outboundWeek.length ? `${Math.round((booked / outboundWeek.length) * 100)}%` : "—";
    return [
      { label: "Calls made this week", value: outboundWeek.length },
      { label: "Connects this week", value: connects },
      { label: "Meetings booked this week", value: booked },
      { label: "Book rate", value: bookRate },
      { label: "Median speed-to-lead", value: medianSpeedToLead(db) },
    ];
  }
  if (hubId === "audit") {
    const visitsWeek = db.visits.filter((v) => inLastWeek(v.ts));
    return [
      { label: "Notes structured this week", value: visitsWeek.filter((v) => v.auditComplete).length },
    ];
  }
  if (hubId === "billing") {
    const claimsWeek = db.claims.filter((c) => inLastWeek(c.ts));
    return [
      { label: "Claims drafted this week", value: claimsWeek.length },
      { label: "$ drafted this week", value: "$" + claimsWeek.reduce((s, c) => s + (c.amount || 0), 0).toLocaleString() },
    ];
  }
  if (hubId === "librarian") {
    const approvedWeek = db.memory.filter((m) => m.status === "approved" && inLastWeek(m.approvedAt || m.ts));
    return [
      { label: "Facts approved this week", value: approvedWeek.length },
    ];
  }
  return [];
}

function buildGraph(db) {
  const nodes = [];
  const links = [];
  const hubs = activeHubs(db);

  nodes.push({ id: "clinic", type: "clinic", name: db.settings.clinicName || instance.name });

  hubs.forEach((hub) => {
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
  // no phone/PHI rendered on canvas. Only wired to hubs that are actually
  // on the map — an inactive leads/calling agent just means no dust nodes,
  // never a dangling link to a hub that doesn't exist this request.
  const hubIds = new Set(hubs.map((h) => h.id));
  db.leads.slice(0, 12).forEach((l) => {
    const owner = l.status === "booked" || l.status === "seen" ? "calling" : "leads";
    if (!hubIds.has(owner)) return;
    const pid = "patient_" + l.id;
    nodes.push({ id: pid, type: "patient", name: l.name });
    links.push({ source: owner, target: pid, kind: "orbit" });
  });

  // hand-off chain: explicit handoff: frontmatter wins per-hub; if no hub
  // declares one at all, fall back to the original implicit linear chain
  // (in declared order) so existing deployments render unchanged. Only
  // ever links between hubs that are actually active this request.
  const anyExplicitHandoff = hubs.some((h) => h.handoff && h.handoff.length);
  if (anyExplicitHandoff) {
    hubs.forEach((hub) => {
      (hub.handoff || []).forEach((targetId) => {
        if (hubIds.has(targetId)) links.push({ source: hub.id, target: targetId, kind: "handoff" });
      });
    });
  } else {
    for (let i = 0; i < hubs.length - 1; i++) {
      links.push({ source: hubs[i].id, target: hubs[i + 1].id, kind: "handoff" });
    }
  }

  return {
    nodes, links,
    stats: {
      agents: hubs.length,
      actionsThisWeek: db.calls.length + db.leads.length + db.claims.length + db.visits.length,
      connections: links.length,
    },
  };
}

function buildAgentDetail(db, hubId) {
  const hub = CATALOG_HUBS.find((h) => h.id === hubId);
  if (!hub) return null;
  const a = hub.agentId ? db.agents.find((x) => x.id === hub.agentId) : null;
  const detail = {
    id: hub.id, name: hub.name, color: hub.color, glyph: hub.glyph, tagline: hub.tagline,
    agentId: hub.agentId || null,
    status: agentStatus(db, hub),
    lastRun: a ? a.lastRun : null,
    lastResult: a ? a.lastResult : null,
    workflows: hub.workflows,
    tools: hub.tools.map((tid) => db.integrations.find((i) => i.id === tid)).filter(Boolean)
      .map((i) => ({ name: i.name, connected: !!process.env[i.envKey] || i.status === "connected" })),
    todayStats: todayStats(db, hub.id),
    weekStats: weekStats(db, hub.id),
    recentActivity: recentActivity(db, hub.id),
  };
  // The librarian/vapiSync pipeline only ever affects the receptionist's
  // live phone prompt — surface its sync status right on that hub, not as
  // a separate UI area.
  if (hubId === "receptionist") {
    const versions = db.promptVersions || [];
    const latest = versions[versions.length - 1] || null;
    detail.knowledgeSync = {
      version: versions.length,
      pushedAt: latest ? latest.ts : null,
      dryRun: latest ? !!latest.dryRun : null,
    };
  }
  return detail;
}

module.exports = { buildGraph, buildAgentDetail, activeHubs, CATALOG_HUBS, weekStats };
