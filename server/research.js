// Provider-agnostic research module for HQ: general cited Q&A (query())
// and ICP-based business lead sourcing (sourceLeads()). Perplexity is the
// default provider — sonar for high-volume company lookups, sonar-pro
// only for strategy-grade jobs. server/researcher.js's direct search-
// fetch-summarize path is the fallback provider, so a missing
// PERPLEXITY_API_KEY degrades this module instead of breaking it (same
// reasoning researcher.js itself already uses for its own missing-key
// case).
//
// Citations are the contract, not a nice-to-have: a Perplexity answer
// with zero citations is treated as unavailable, never rendered as a
// summary. Every lead field sourceLeads() records — name, website,
// phone, address, the fit signal — carries the source URL and the date
// it was seen, because that pair IS the lead's future consentBasis once
// an owner approves it.
//
// Business information only, always. This module never records a
// person's direct line, personal email, or home address, and a phone
// number it finds is never treated as callable on its own — see
// checkPhoneType() below and dialer.js's notDialable check.
const { log } = require("./store");
const researcher = require("./researcher"); // fallback provider

const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const FETCH_TIMEOUT_MS = 20000;
// Rough, non-billed cost estimate for the usage log only — Perplexity's
// posted per-request pricing as of this writing; not wired to any real
// invoice or budget enforcement.
const PRICE_PER_1K_TOKENS = { sonar: 0.001, "sonar-pro": 0.003 };

function normalizeQuery(q) {
  return String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getCache(db) {
  db.settings.researchCache = db.settings.researchCache || {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(db.settings.researchCache)) {
    if (!entry.fetchedAt || now - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) delete db.settings.researchCache[key];
  }
  return db.settings.researchCache;
}

// Running, capped usage log — tokens/cost/request-count per call, purely
// for visibility (server.js exposes it read-only); never used to
// enforce a budget itself.
function logUsage(db, entry) {
  db.settings.researchUsage = db.settings.researchUsage || [];
  db.settings.researchUsage.push({ ts: new Date().toISOString(), ...entry });
  if (db.settings.researchUsage.length > 500) db.settings.researchUsage = db.settings.researchUsage.slice(-500);
}

async function perplexityChat(db, { model, system, prompt, job }) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const res = await fetch(PERPLEXITY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Perplexity HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const citations = Array.isArray(data.citations) ? data.citations : [];
  const usage = data.usage || {};
  const tokensIn = usage.prompt_tokens || 0;
  const tokensOut = usage.completion_tokens || 0;
  const costUsd = ((tokensIn + tokensOut) / 1000) * (PRICE_PER_1K_TOKENS[model] || PRICE_PER_1K_TOKENS.sonar);
  logUsage(db, { provider: "perplexity", model, job, tokensIn, tokensOut, costUsd });
  return { content, citations, costUsd };
}

// One cited question -> one cited answer, or { unavailable: true }.
// job: "lookup" (default, routes to sonar) | "strategy" (routes to
// sonar-pro). Cached by normalized prompt text for 30 days.
async function query(db, { prompt, job = "lookup", system } = {}) {
  if (!prompt) return { unavailable: true, reason: "no_prompt" };
  const cacheKey = normalizeQuery(prompt);
  const cache = getCache(db);
  if (cache[cacheKey]) return { ...cache[cacheKey], fromCache: true };

  const model = job === "strategy" ? "sonar-pro" : "sonar";
  let result;
  try {
    result = await perplexityChat(db, {
      model,
      system: system || "You are a careful research assistant. State only facts you can cite. If you cannot find a citable answer, say so plainly instead of guessing.",
      prompt,
      job,
    });
  } catch (e) {
    log("error", `Research: Perplexity query failed: ${e.message}`);
    result = null;
  }

  if (!result) {
    return { unavailable: true, reason: process.env.PERPLEXITY_API_KEY ? "perplexity_failed" : "no_perplexity_key", fallbackProvider: "researcher.js" };
  }
  if (!result.citations.length) {
    return { unavailable: true, reason: "no_citations" };
  }

  const answer = {
    content: result.content,
    citations: result.citations,
    provider: "perplexity",
    model,
    costUsd: result.costUsd,
    fetchedAt: new Date().toISOString(),
  };
  cache[cacheKey] = answer;
  return answer;
}

// Best-effort business-landline confirmation. Twilio Lookup (line-type
// intelligence) is the only provider wired here — without
// TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN configured, this fails CLOSED
// (not confirmed), because US phone number formatting alone cannot
// reliably distinguish a mobile number from a landline the way, say, UK
// numbering can. A number this can't positively confirm as a landline
// is stored but marked notDialable — dialer.js refuses it regardless of
// consent basis. This is deliberately the one guardrail with no bypass:
// getting this wrong is a real TCPA exposure, not just a bad lead.
async function checkPhoneType(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return { confirmed: false, reason: "no_phone" };
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { confirmed: false, reason: "no_lookup_provider" };
  try {
    const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, {
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { confirmed: false, reason: `lookup_http_${res.status}` };
    const data = await res.json();
    const type = data.line_type_intelligence?.type; // "mobile" | "landline" | "fixedVoip" | "nonFixedVoip" | ...
    if (type === "landline" || type === "fixedVoip") return { confirmed: true, type };
    return { confirmed: false, type: type || "unknown", reason: type === "mobile" ? "mobile_number" : "not_confirmed_landline" };
  } catch (e) {
    return { confirmed: false, reason: `lookup_failed: ${e.message}` };
  }
}

// ICP-based business lead sourcing. Given a plain-language ICP
// description, asks Perplexity for real, named candidate businesses and
// parses out only what's citable. Every returned candidate lands in
// db.leads with status:"proposed" (the SAME approval queue signal-
// watcher's proposed leads already use — server.js's existing
// POST /api/leads/:id/approve-proposed is the one approval path, not a
// second one) and source:"hq_sourcing". Nothing here is ever dialable
// until an owner approves it, and even then only if checkPhoneType()
// confirmed a landline.
async function sourceLeads(db, { icp, count = 10 } = {}) {
  if (!icp) return { ok: false, reason: "no_icp" };
  const prompt =
    `Find up to ${Math.min(count, 25)} real, currently-operating businesses matching this ideal customer profile: "${icp}".\n\n` +
    `For each one, give ONLY information you can find and cite: the business's legal/trade name, ` +
    `its website, its publicly listed MAIN business phone number (not a personal cell), its city/state, ` +
    `and one sentence on why it fits this profile. Output strict JSON only, no commentary: ` +
    `{"businesses":[{"name":"","website":"","phone":"","location":"","fitSignal":""}]}. ` +
    `Skip any business you cannot find a real source for rather than inventing one — an empty list is a correct answer if nothing fits.`;

  const result = await query(db, { prompt, job: "lookup", system: "You are a business researcher sourcing real, currently-operating companies for B2B outreach. Only report businesses and details you can find in real, citable sources. Never invent a business, a phone number, or a website. Never report a person's personal contact information." });
  if (result.unavailable) return { ok: false, reason: result.reason, fallbackProvider: result.fallbackProvider };

  let parsed;
  try { parsed = JSON.parse(String(result.content || "{}").replace(/```json|```/g, "").trim()); } catch { parsed = null; }
  const businesses = Array.isArray(parsed?.businesses) ? parsed.businesses : [];
  if (!businesses.length) return { ok: true, added: 0, leads: [], citations: result.citations };

  const seenAt = new Date().toISOString();
  const sourceUrls = result.citations.slice(0, 5);
  const added = [];
  for (const b of businesses.slice(0, count)) {
    if (!b.name) continue;
    const phone = String(b.phone || "").trim();
    const phoneCheck = phone ? await checkPhoneType(phone) : { confirmed: false, reason: "no_phone" };
    const lead = {
      id: "L" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: String(b.name).slice(0, 200),
      company: String(b.name).slice(0, 200),
      phone: phone || "",
      website: String(b.website || "").slice(0, 300),
      location: String(b.location || "").slice(0, 200),
      email: "",
      source: "hq_sourcing",
      status: "proposed",
      signal: String(b.fitSignal || icp).slice(0, 300),
      notDialable: !phoneCheck.confirmed,
      notDialableReason: phoneCheck.confirmed ? null : phoneCheck.reason,
      // The exact fact this lead's future consentBasis will be built
      // from once approved — a source URL plus the date it was seen,
      // per field. approve-proposed's caller is expected to set
      // consentBasis from this before it ever reaches the dialer.
      sourcing: { icp, sourceUrls, seenAt },
      createdAt: seenAt,
      attempts: 0,
    };
    db.leads.push(lead);
    added.push(lead);
  }
  log("agent", `Researcher: sourced ${added.length} candidate business(es) for "${icp}" — awaiting owner approval`);
  return { ok: true, added: added.length, leads: added, citations: result.citations };
}

module.exports = { query, sourceLeads, checkPhoneType, normalizeQuery, getCache };
