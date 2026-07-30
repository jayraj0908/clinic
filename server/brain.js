// Parses brain/agents/*.md at boot — the source of truth for what agents
// exist, what they do, and what their Claude system prompt is. No heavy
// YAML dependency: the frontmatter here is flat key: value pairs (plus a
// literal `null`), which a few lines of regex handle fine.
//
// Instances may override or add agents: instances/<id>/agents/*.md wins
// over brain/agents/*.md for any file sharing the same `name`.
const fs = require("fs");
const path = require("path");
const { instanceAgentsDir } = require("./instance");

const ENGINE_AGENTS_DIR = path.join(__dirname, "..", "brain", "agents");

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw.trim() };
  const [, yamlBlock, body] = m;
  const data = {};
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val === "null" || val === "~" || val === "") { data[key] = null; continue; }
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    data[key] = val;
  }
  return { data, body: body.trim() };
}

function splitList(val) {
  if (!val) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

// Pulls the bullet list under a "## <heading>" section out of the agent's
// prompt body — used for the `workflows` field the brain graph renders.
function extractSection(body, heading) {
  const startRe = new RegExp(`^##\\s+${heading}\\s*$`, "mi");
  const startMatch = startRe.exec(body);
  if (!startMatch) return [];
  const rest = body.slice(startMatch.index + startMatch[0].length);
  const nextHeadingIdx = rest.search(/^##\s+/m);
  const section = nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
  return section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .map((l) => l.replace(/^-+\s*/, ""));
}

// A workflow bullet may declare an explicit short node label — "- **Short
// Label** — the fuller sentence describing what it actually does". The
// brain map's canvas nodes render `label` (small, fixed space, has to be a
// name); every panel/tooltip that has room renders `detail` (the real
// description). Falls back to a truncated version of the bullet itself if
// a file hasn't been updated to the "**Label** —" convention yet, so an
// old-style plain bullet degrades instead of breaking.
function splitLabelDetail(line) {
  const m = /^\*\*(.+?)\*\*\s*[—-]\s*(.*)$/.exec(line);
  if (m) return { label: m[1].trim(), detail: (m[2] || m[1]).trim() };
  const label = line.length > 28 ? line.slice(0, 28).trim().replace(/\s+\S*$/, "") + "…" : line;
  return { label, detail: line };
}

function loadAgentFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const id = (data.name || path.basename(filePath, ".md")).trim();
  const orderNum = data.order != null ? parseFloat(data.order) : NaN;
  return {
    id,
    description: data.description || "",
    tools: splitList(data.tools),
    // Catalog activation requirements — integration ids (matching
    // server/store.js's db.integrations ids) this agent needs BOTH an env
    // var AND/or a db-stored key for before it can be activated. Distinct
    // from `tools` (which also drives the brain-map's decorative tool
    // nodes) so the two can diverge later without semantic overload.
    requires: splitList(data.requires),
    schedule: data.schedule ?? null, // null = event-driven, never cron-scheduled
    model: data.model || null,
    // presentation/graph-mapping — optional, defaults keep a new agent
    // file fully self-describing without touching engine code
    displayName: data.displayname || data.displayName || id,
    color: data.color || "#8a8a86",
    glyph: data.glyph || "◆",
    tagline: data.tagline || "",
    runner: data.runner !== undefined ? data.runner : id, // db.agents id this hub's status/stats are read from
    order: Number.isFinite(orderNum) ? orderNum : Infinity,
    // instance override sets disabled: true to drop this agent entirely for
    // that instance — see loadAgents() below. A minimal override file
    // (just name + disabled: true) is enough; nothing else in this record
    // matters once it's filtered out.
    disabled: data.disabled === "true" || data.disabled === true,
    // optional pipeline metadata (Stage 2 hard requirement: support, not require)
    triggers: splitList(data.triggers),
    handoff: splitList(data.handoff),
    body,
    workflows: extractSection(body, "Workflows").map(splitLabelDetail),
    // Client-facing "what you'll see" bullets for the catalog/agent panel —
    // honest outcome copy, not implementation detail (that's Workflows).
    results: extractSection(body, "Results"),
  };
}

function loadAgents() {
  const byId = {};
  if (fs.existsSync(ENGINE_AGENTS_DIR)) {
    for (const f of fs.readdirSync(ENGINE_AGENTS_DIR).filter((f) => f.endsWith(".md"))) {
      const agent = loadAgentFile(path.join(ENGINE_AGENTS_DIR, f));
      byId[agent.id] = agent;
    }
  }
  if (fs.existsSync(instanceAgentsDir)) {
    for (const f of fs.readdirSync(instanceAgentsDir).filter((f) => f.endsWith(".md"))) {
      const agent = loadAgentFile(path.join(instanceAgentsDir, f));
      byId[agent.id] = agent; // instance file wins over the engine default of the same name
    }
  }

  // An instance override with disabled: true drops that agent entirely —
  // not just hidden, gone from the catalog/graph/scheduler/prompt
  // pipeline, as if the file were never loaded. This is the one remaining
  // hard removal: "this isn't a capability we offer this vertical at all",
  // as opposed to "offered but not activated yet" (see server/catalog.js).
  for (const id of Object.keys(byId)) {
    if (byId[id].disabled) delete byId[id];
  }

  // instance.json's "agents" allowlist used to also filter this list down
  // — it no longer does. AGENTS is now the FULL catalog every client can
  // see (brain/agents/*.md is "every agent that could exist for anyone");
  // which of them are actually running is a separate, DB-backed layer
  // (server/catalog.js's getActiveAgentIds, which still reads this same
  // instance.agents field — just as a fallback default for what's ACTIVE,
  // not as a filter on what EXISTS).
  return byId;
}

const AGENTS = loadAgents();

module.exports = { AGENTS, loadAgents, parseFrontmatter, extractSection };
