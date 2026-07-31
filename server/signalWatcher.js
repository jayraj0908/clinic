// Signal watcher — reads a per-instance watchlist of public RSS/URL feeds
// (always available) and web searches (only with BRAVE_API_KEY set) for
// genuine public buying signals, then proposes them as leads for the
// owner to approve. NEVER contacts anyone — see clients/
// myrtle-beach-hotels.md's "public posts, not private searches" framing;
// this is the "public-signal monitoring" piece of that plan, generalized
// to any instance/vertical via db.settings.signalWatch.
const { load, save, log } = require("./store");
const { instance } = require("./instance");
const catalog = require("./catalog");

// Minimal RSS 2.0 <item> extractor — regex-based, not a full XML parser,
// matching this codebase's existing "no heavy dependency" convention
// (server/brain.js's frontmatter parser does the same trade-off). Good
// enough for standard RSS; an Atom-only feed or malformed XML just
// yields zero items rather than throwing.
function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks.slice(0, 15)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
    };
    const title = pick("title");
    if (!title) continue;
    items.push({ title, link: pick("link"), description: pick("description").slice(0, 500) });
  }
  return items;
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) { log("system", `Signal Watcher: feed returned HTTP ${res.status} (${url})`); return []; }
    return parseRssItems(await res.text()).map((it) => ({ ...it, watchSource: url, kind: "feed" }));
  } catch (e) {
    log("system", `Signal Watcher: feed fetch failed (${url}): ${e.message}`);
    return [];
  }
}

// Shaped from Brave Search API's documented pattern, not yet exercised
// against a live key in this repo — same "confirm against current docs
// before relying on it live" caveat every other unverified integration
// in this codebase already carries.
async function braveSearch(query) {
  try {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
      headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { log("system", `Signal Watcher: search returned HTTP ${res.status} (${query})`); return []; }
    const data = await res.json();
    return (data.web?.results || []).slice(0, 8).map((r) => ({ title: r.title, link: r.url, description: r.description || "", watchSource: query, kind: "search" }));
  } catch (e) {
    log("system", `Signal Watcher: search failed (${query}): ${e.message}`);
    return [];
  }
}

async function runSignalWatch() {
  const db = load();
  const watch = db.settings.signalWatch || {};
  const feeds = watch.feeds || [];
  const queries = watch.queries || [];
  if (!feeds.length && !queries.length) {
    log("agent", "Signal Watcher: no watchlist configured — nothing to check");
    return "no watchlist";
  }
  if (!catalog.resolveKey(db, "anthropic")) {
    log("agent", "Signal Watcher: no Anthropic key configured — skipped");
    return "no API key";
  }

  const rawSignals = [];
  for (const url of feeds) rawSignals.push(...(await fetchFeed(url)));
  if (process.env.BRAVE_API_KEY) {
    for (const q of queries) rawSignals.push(...(await braveSearch(q)));
  } else if (queries.length) {
    log("agent", `Signal Watcher: ${queries.length} search quer${queries.length > 1 ? "ies" : "y"} configured but no BRAVE_API_KEY — RSS/feed watchlist only this run`);
  }
  if (!rawSignals.length) {
    log("agent", "Signal Watcher: checked the watchlist, nothing new");
    return "nothing found";
  }

  const { claude } = require("./agents"); // lazy require — agents.js's `agents` dict calls into this module, so a top-level require here would be circular
  const out = await claude(
    db,
    `Below are items from a business's public watchlist (RSS feeds and/or web search results). Identify ONLY genuine PUBLIC buying signals relevant to ${instance.name || "this business"} (${instance.vertical || "business"}) — a real person or organization publicly expressing genuine intent to book/hire/buy something this business offers. Skip anything that's just news, unrelated content, or a private individual's personal post that isn't a real transaction signal. Never include personal contact details of a private individual beyond what's already public in the item itself — public BUSINESS/organization info only.\n\n` +
      `Output STRICT JSON only: {"signals":[{"title":"...","link":"...","reason":"why this is a genuine signal","suggestedContact":"organization/business name if identifiable, else empty string"}]}. Return {"signals":[]} if nothing qualifies — silence is a valid, often correct output.\n\n` +
      rawSignals.map((s, i) => `${i + 1}. ${s.title}\n${s.link}\n${s.description}`).join("\n\n"),
    "You filter public web content for genuine business buying signals. Public business/organization info only — never propose contacting a private individual from a personal post. Strict JSON only, no commentary."
  );
  let filtered = [];
  try { filtered = JSON.parse((out || "{}").replace(/```json|```/g, "").trim()).signals || []; } catch { filtered = []; }

  let added = 0;
  for (const s of filtered) {
    if (!s || !s.title) continue;
    const dup = db.leads.some((l) => l.status === "proposed" && l.signal?.link && l.signal.link === s.link);
    if (dup) continue;
    db.leads.unshift({
      id: "L" + Date.now() + added,
      name: s.suggestedContact || s.title,
      phone: "",
      email: "",
      source: "signal",
      service: "",
      status: "proposed", // distinct from "new" — never auto-contacted; see maybeAutoQueueLead, which only ever fires on creation of a "new" lead, not "proposed"
      createdAt: new Date().toISOString(),
      signal: { title: s.title, link: s.link || "", reason: s.reason || "" },
    });
    added++;
  }
  save();
  log("agent", `Signal Watcher: ${added} new proposed lead(s) from ${rawSignals.length} item(s) checked`);
  return `${added} proposed`;
}

module.exports = { runSignalWatch, parseRssItems };
