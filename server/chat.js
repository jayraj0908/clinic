// Read-only chat with the brain — Claude tool-use over a fixed whitelist of
// read functions over the store. No action tools in this pass (block
// calendar, run agent, etc. come later, per spec).
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

const toolDefs = [
  { name: "get_stats", description: "Get aggregate funnel/call/appointment/claim stats for a period.", input_schema: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month"], description: "Time window, defaults to week" } } } },
  { name: "search_leads", description: "Search leads by name, phone, email, service, source, or status.", input_schema: { type: "object", properties: { q: { type: "string", description: "Search text; omit or empty for all leads" } } } },
  { name: "search_calls", description: "Search call records by caller, summary, outcome, or direction.", input_schema: { type: "object", properties: { filter: { type: "string", description: "Search text; omit or empty for all calls" } } } },
  { name: "get_appointments", description: "List appointments, optionally within a date range.", input_schema: { type: "object", properties: { from: { type: "string", description: "ISO date, inclusive" }, to: { type: "string", description: "ISO date, inclusive" } } } },
  { name: "get_claims", description: "List insurance claims, optionally filtered by status (e.g. awaiting_approval, approved).", input_schema: { type: "object", properties: { status: { type: "string" } } } },
];

function systemPrompt() {
  return `You are ${instance.name}'s brain. Answer from tool results only. Be concise. Amounts in dollars. If asked to take an action, say which button in the dashboard does it — action tools come later.`;
}

// messages: [{role:'user'|'assistant', content:string}], most recent last.
async function runChat(messages) {
  if (!hasKey("ANTHROPIC_API_KEY")) {
    return "Chat isn't connected yet — add ANTHROPIC_API_KEY to enable it.";
  }
  let convo = messages.slice(-20).map((m) => ({ role: m.role, content: m.content }));
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
      return (data.content || []).map((c) => c.text || "").join("").trim() || "I don't have an answer for that.";
    }
    convo = [...convo, { role: "assistant", content: data.content }];
    const toolResults = toolUses.map((tu) => {
      let output;
      try {
        output = readTools[tu.name] ? readTools[tu.name](tu.input || {}) : { error: `Unknown tool ${tu.name}` };
      } catch (e) {
        output = { error: e.message };
      }
      return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output) };
    });
    convo = [...convo, { role: "user", content: toolResults }];
  }
  return "I wasn't able to finish answering that — try rephrasing your question.";
}

module.exports = { runChat };
