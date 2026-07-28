// Chat with the brain — Claude tool-use over a whitelist of read functions
// plus a small set of action tools. Action tools never mutate anything
// themselves: they validate the target exists and hand back a
// {label, method, path} descriptor — the exact same shape /api/attention
// already uses for the bell's one-click buttons — pointing at the real,
// already-authenticated, already-permission-gated route (queue-call,
// confirm-appointment, approve-claim, run-agent). The actual mutation only
// ever happens when the signed-in user clicks the confirm button the
// frontend renders from that descriptor. Chat proposes; a human approves.
const { load } = require("./store");
const { instance } = require("./instance");

const hasKey = (k) => !!process.env[k];

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function inRange(ts, from, to) {
  const t = new Date(ts).getTime();
  return (!from || t >= new Date(from).getTime()) && (!to || t <= new Date(to).getTime());
}

const readTools = {
  get_stats({ period } = {}) {
    const db = load();
    const days = period === "today" ? 1 : period === "month" ? 30 : 7;
    const since = daysAgo(days);
    const leadsInPeriod = db.leads.filter((l) => new Date(l.createdAt) >= since);
    const callsInPeriod = db.calls.filter((c) => new Date(c.ts) >= since);
    const booked = db.leads.filter((l) => ["booked", "seen", "audited", "billed"].includes(l.status));
    return {
      period: period || "week",
      totalLeads: db.leads.length,
      leadsInPeriod: leadsInPeriod.length,
      totalCalls: db.calls.length,
      callsInPeriod: callsInPeriod.length,
      missedCallsInPeriod: callsInPeriod.filter((c) => c.outcome === "missed").length,
      totalAppointments: db.appointments.length,
      bookedLeads: booked.length,
      claimsAwaitingApproval: db.claims.filter((c) => c.status === "awaiting_approval").length,
      revenueEstDollars: booked.length * (db.settings?.avgVisitValue || 0),
    };
  },
  search_leads({ q } = {}) {
    const db = load();
    const needle = String(q || "").toLowerCase();
    return db.leads
      .filter((l) => !needle || [l.name, l.phone, l.email, l.service, l.source, l.status].some((v) => String(v || "").toLowerCase().includes(needle)))
      .slice(0, 25)
      .map((l) => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, service: l.service, source: l.source, status: l.status, createdAt: l.createdAt }));
  },
  search_calls({ filter } = {}) {
    const db = load();
    const needle = String(filter || "").toLowerCase();
    return db.calls
      .filter((c) => !needle || [c.who, c.summary, c.outcome, c.dir].some((v) => String(v || "").toLowerCase().includes(needle)))
      .slice(0, 25)
      .map((c) => ({ id: c.id, who: c.who, dir: c.dir, outcome: c.outcome, summary: c.summary, ts: c.ts }));
  },
  get_appointments({ from, to } = {}) {
    const db = load();
    return db.appointments
      .filter((a) => inRange(a.time, from, to))
      .slice(0, 50)
      .map((a) => ({ id: a.id, name: a.name, service: a.service, time: a.time, status: a.status, source: a.source }));
  },
  get_claims({ status } = {}) {
    const db = load();
    return db.claims
      .filter((c) => !status || c.status === status)
      .slice(0, 50)
      .map((c) => ({ id: c.id, status: c.status, amountDollars: c.amount, codes: (c.codes || []).map((x) => x.code || x), ts: c.ts }));
  },
};

// Each action tool returns { proposed: true, action: {label, method, path} }
// on success, or { error } if the target doesn't exist — it never touches
// the database itself.
const actionTools = {
  queue_call({ lead_id } = {}) {
    const db = load();
    const lead = db.leads.find((l) => l.id === lead_id);
    if (!lead) return { error: `No lead with id ${lead_id}` };
    return {
      proposed: true,
      summary: `Queue ${lead.name} for a priority callback.`,
      action: { label: `Queue ${lead.name} for a callback`, method: "POST", path: `/api/leads/${lead.id}/queue-call` },
    };
  },
  confirm_appointment({ appointment_id } = {}) {
    const db = load();
    const appt = db.appointments.find((a) => a.id === appointment_id);
    if (!appt) return { error: `No appointment with id ${appointment_id}` };
    return {
      proposed: true,
      summary: `Confirm the ${appt.service || "visit"} appointment for ${appt.name} at ${appt.time}.`,
      action: { label: `Confirm ${appt.name}'s appointment`, method: "POST", path: `/api/appointments/${appt.id}/confirm` },
    };
  },
  approve_claim({ claim_id } = {}) {
    const db = load();
    const claim = db.claims.find((c) => c.id === claim_id);
    if (!claim) return { error: `No claim with id ${claim_id}` };
    return {
      proposed: true,
      summary: `Approve claim ${claim.id} for submission. Requires owner access.`,
      action: { label: `Approve claim ${claim.id}`, method: "POST", path: `/api/claims/${claim.id}/approve` },
    };
  },
  run_agent({ agent_id } = {}) {
    const db = load();
    const agent = db.agents.find((a) => a.id === agent_id);
    if (!agent) return { error: `No agent with id ${agent_id}` };
    const warning = agent_id === "setter" ? " This places real outbound calls to qualified leads if Vapi is connected." : "";
    return {
      proposed: true,
      summary: `Run ${agent.name} now.${warning}`,
      action: { label: `Run ${agent.name} now`, method: "POST", path: `/api/agents/${agent.id}/run` },
    };
  },
};

const toolDefs = [
  { name: "get_stats", description: "Get aggregate funnel/call/appointment/claim stats for a period.", input_schema: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month"], description: "Time window, defaults to week" } } } },
  { name: "search_leads", description: "Search leads by name, phone, email, service, source, or status.", input_schema: { type: "object", properties: { q: { type: "string", description: "Search text; omit or empty for all leads" } } } },
  { name: "search_calls", description: "Search call records by caller, summary, outcome, or direction.", input_schema: { type: "object", properties: { filter: { type: "string", description: "Search text; omit or empty for all calls" } } } },
  { name: "get_appointments", description: "List appointments, optionally within a date range.", input_schema: { type: "object", properties: { from: { type: "string", description: "ISO date, inclusive" }, to: { type: "string", description: "ISO date, inclusive" } } } },
  { name: "get_claims", description: "List insurance claims, optionally filtered by status (e.g. awaiting_approval, approved).", input_schema: { type: "object", properties: { status: { type: "string" } } } },
  { name: "queue_call", description: "Propose queuing a lead for a priority callback (the calling agent's next run picks it up first). Look up the lead's id with search_leads first. Does not execute — the user must confirm.", input_schema: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"] } },
  { name: "confirm_appointment", description: "Propose marking an appointment confirmed. Look up its id with get_appointments first. Does not execute — the user must confirm.", input_schema: { type: "object", properties: { appointment_id: { type: "string" } }, required: ["appointment_id"] } },
  { name: "approve_claim", description: "Propose approving an insurance claim for submission (owner-only). Look up its id with get_claims first. Does not execute — the user must confirm.", input_schema: { type: "object", properties: { claim_id: { type: "string" } }, required: ["claim_id"] } },
  { name: "run_agent", description: "Propose running one of the 4 agents right now: intake, setter, audit, or billing. Does not execute — the user must confirm.", input_schema: { type: "object", properties: { agent_id: { type: "string", enum: ["intake", "setter", "audit", "billing"] } }, required: ["agent_id"] } },
];

function systemPrompt() {
  return [
    `You are ${instance.name}'s brain. Answer from tool results only. Be concise. Amounts in dollars.`,
    `You can propose actions (queue_call, confirm_appointment, approve_claim, run_agent) but you never execute them yourself — calling one of those tools only drafts a confirm button for the user, it does not perform the action. After proposing one, tell the user in plain language what it will do and that it's waiting on their confirm click. Never claim an action is done unless a tool result says so.`,
    `Look up an id (search_leads, get_appointments, get_claims) before proposing an action on it — never guess an id.`,
  ].join(" ");
}

// messages: [{role:'user'|'assistant', content:string}], most recent last.
// Returns {reply, actions} — actions is a deduped list of {label, method, path}
// descriptors the frontend renders as confirm buttons.
async function runChat(messages) {
  if (!hasKey("ANTHROPIC_API_KEY")) {
    return { reply: "Chat isn't connected yet — add ANTHROPIC_API_KEY to enable it.", actions: [] };
  }
  let convo = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  const actions = [];
  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt(),
        tools: toolDefs,
        messages: convo,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
    const toolUses = (data.content || []).filter((c) => c.type === "tool_use");
    if (!toolUses.length) {
      const reply = (data.content || []).map((c) => c.text || "").join("").trim() || "I don't have an answer for that.";
      return { reply, actions };
    }
    convo = [...convo, { role: "assistant", content: data.content }];
    const toolResults = toolUses.map((tu) => {
      let output;
      try {
        if (readTools[tu.name]) output = readTools[tu.name](tu.input || {});
        else if (actionTools[tu.name]) {
          output = actionTools[tu.name](tu.input || {});
          if (output.proposed && output.action) actions.push(output.action);
        } else output = { error: `Unknown tool ${tu.name}` };
      } catch (e) {
        output = { error: e.message };
      }
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output) };
    });
    convo = [...convo, { role: "user", content: toolResults }];
  }
  return { reply: "I wasn't able to finish answering that — try rephrasing your question.", actions };
}

module.exports = { runChat };
