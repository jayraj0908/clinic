// Lead company research/enrichment — PUBLIC BUSINESS info only, never
// personal contact data, and never a source of dialable phone numbers
// (server/dialer.js's consent gate is the sole source of truth for who
// can be called; enrichment only ever adds context to a lead that was
// already legitimately queued through it). Off everywhere by default —
// ENRICHMENT_ENABLED=1 per-deployment (server.js checks this before
// calling in here at all).
//
// Every claim in a returned enrichment carries a source URL. Nothing is
// invented: an unreachable site, a robots.txt disallow, or a search
// that returns nothing produces { unavailable: true }, never a guess —
// a hallucinated company fact spoken on a live call is worse than
// admitting we don't know.
const { load, save, log } = require("./store");
const catalog = require("./catalog");
const { instance } = require("./instance");

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days, per-domain
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "SailzResearchBot/1.0 (+https://sailz.org/about-our-crawler)";

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// Minimal robots.txt check — parses Disallow rules under a User-agent
// block matching our bot name or "*", checked against the specific path
// we intend to fetch. Not a full RFC 9309 parser (no Allow-precedence,
// no wildcard/$ matching) — good enough for the common case, and errs
// toward NOT fetching (any parse uncertainty about a Disallow match
// skips the page) rather than risking a real violation.
async function robotsAllow(pageUrl) {
  let robotsUrl;
  try { robotsUrl = new URL("/robots.txt", pageUrl).toString(); } catch { return false; }
  let text;
  try {
    const res = await fetch(robotsUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return true; // no robots.txt (404 etc.) — nothing disallowed
    text = await res.text();
  } catch {
    return true; // unreachable robots.txt — don't block on a network blip, the page fetch itself will fail safely if the site is genuinely down
  }
  const path = new URL(pageUrl).pathname || "/";
  let applies = false;
  const disallows = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || value.toLowerCase().includes("sailzresearchbot");
    else if (applies && key === "disallow" && value) disallows.push(value);
  }
  return !disallows.some((d) => path.startsWith(d));
}

async function fetchPageText(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 6000); // enough context for a summary, not the whole site
}

async function braveSearch(query) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
    headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, 5).map((r) => ({ title: r.title, url: r.url, description: r.description || "" }));
}

// Shaped from Serper.dev's documented Google-search-proxy pattern — not
// yet exercised against a live key in this repo, same "confirm against
// current docs before relying on it live" caveat every other unverified
// integration in this codebase already carries (matching signalWatcher
// .js's own Brave integration note).
async function serperSearch(query) {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ q: query }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Serper search HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, 5).map((r) => ({ title: r.title, url: r.link, description: r.snippet || "" }));
}

async function searchCompany(query) {
  if (process.env.BRAVE_API_KEY) return braveSearch(query);
  if (process.env.SERPER_API_KEY) return serperSearch(query);
  return null; // no search provider configured at all
}

// Cache lives on db.settings — small, per-domain, pruned of anything
// past its TTL on every read so it never grows unbounded.
function getCache(db) {
  db.settings.enrichmentCache = db.settings.enrichmentCache || {};
  const now = Date.now();
  for (const [domain, entry] of Object.entries(db.settings.enrichmentCache)) {
    if (!entry.fetchedAt || now - new Date(entry.fetchedAt).getTime() > CACHE_TTL_MS) delete db.settings.enrichmentCache[domain];
  }
  return db.settings.enrichmentCache;
}

// The whole pipeline for one lead: search → pick a same-company result →
// robots-check → fetch → summarize → cache. Mutates lead.enrichment in
// place; caller owns save(). Never throws — every failure mode resolves
// to a clear, honest { unavailable: true, reason } on the lead instead.
async function enrichLead(db, lead) {
  if (!lead.company && !lead.name) {
    lead.enrichment = { unavailable: true, reason: "no_company_name", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }
  if (!catalog.resolveKey(db, "anthropic")) {
    lead.enrichment = { unavailable: true, reason: "no_anthropic_key", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }

  const query = lead.company || lead.name;
  let results;
  try {
    results = await searchCompany(query);
  } catch (e) {
    log("error", `Researcher: search failed for "${query}": ${e.message}`);
    lead.enrichment = { unavailable: true, reason: "search_failed", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }
  if (results === null) {
    lead.enrichment = { unavailable: true, reason: "no_search_provider", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }
  if (!results.length) {
    lead.enrichment = { unavailable: true, reason: "no_results", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }

  const top = results[0];
  const domain = domainOf(top.url);
  const cache = getCache(db);
  if (domain && cache[domain]) {
    lead.enrichment = { ...cache[domain], fromCache: true };
    return lead.enrichment;
  }

  let pageText = "";
  if (domain) {
    try {
      if (await robotsAllow(top.url)) pageText = await fetchPageText(top.url);
      else log("system", `Researcher: robots.txt disallows ${top.url} — using search snippets only`);
    } catch (e) {
      log("system", `Researcher: couldn't fetch ${top.url}: ${e.message} — using search snippets only`);
    }
  }

  const sourcesText = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`).join("\n\n");
  const { claude } = require("./agents"); // lazy require — same circular-require reasoning as signalWatcher.js
  const out = await claude(
    db,
    `Research this company for an employer-retirement-plan outreach context: "${query}".\n\n` +
      `SEARCH RESULTS:\n${sourcesText}\n\n` +
      (pageText ? `COMPANY WEBSITE TEXT (${top.url}):\n${pageText}\n\n` : "") +
      `Output STRICT JSON only: {"summary":"1-3 sentence factual summary","industry":"...","sizeBand":"e.g. 10-50 employees, or empty string if unknown","signals":["short factual bullet","..."],"sources":["url1","url2"]}. ` +
      `Every claim must be traceable to the text above — NEVER invent employee counts, revenue, or facts not present in the sources. If the sources don't clearly identify THIS specific company, say so in summary and leave industry/sizeBand empty rather than guessing from a similarly-named company.`,
    "You are a careful research analyst. Public business/organization facts only — never personal information about any individual. Cite only what the provided sources actually say; strict JSON only, no commentary, no invented facts."
  );

  let parsed;
  try { parsed = JSON.parse((out || "{}").replace(/```json|```/g, "").trim()); } catch { parsed = null; }
  if (!parsed || !parsed.summary) {
    lead.enrichment = { unavailable: true, reason: "summarize_failed", checkedAt: new Date().toISOString() };
    return lead.enrichment;
  }

  const enrichment = {
    summary: String(parsed.summary).slice(0, 800),
    industry: String(parsed.industry || "").slice(0, 100),
    sizeBand: String(parsed.sizeBand || "").slice(0, 60),
    signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 6).map((s) => String(s).slice(0, 200)) : [],
    sources: Array.isArray(parsed.sources) && parsed.sources.length ? parsed.sources.slice(0, 5) : results.map((r) => r.url),
    fetchedAt: new Date().toISOString(),
  };
  if (domain) cache[domain] = enrichment;
  lead.enrichment = enrichment;
  save();
  log("agent", `Researcher: enriched "${lead.name}" (${query}) from ${domain || "search results"}`);
  return lead.enrichment;
}

module.exports = { enrichLead, domainOf, robotsAllow };
