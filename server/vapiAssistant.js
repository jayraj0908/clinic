// Vapi "assistant-request" support — the repo becomes the single source of
// truth for what the phone line knows, instead of a hand-pasted copy living
// in the Vapi dashboard that silently drifts from clinic-profile.json.
//
// Feature-flagged: only used when VAPI_ASSISTANT_REQUEST=1 (see the
// assistant-request branch in server.js's /webhooks/vapi handler). Flag
// off/absent → this module is never called; Vapi uses the dashboard-
// attached assistant exactly as before.
//
// ── Operator steps (after deploy + verification) ───────────────────────
// 1. In the Vapi dashboard, open the phone number and set it to use
//    "assistant request" from this deployment's Server URL
//    (https://<this-service>/webhooks/vapi) — NOT a fixed assistant ID.
// 2. Leave the existing dashboard-pasted assistant attached as the
//    FALLBACK — Vapi automatically falls back to it if this server
//    errors or times out on an assistant-request. Never remove it.
// 3. Set VAPI_ASSISTANT_REQUEST=1 on this Railway service.
// 4. Make one real test call. Then check GET /api/vapi/preview-prompt
//    (owner-only) and confirm it matches what the assistant actually
//    knew on that call.
// 5. Rollback if anything looks wrong: flip VAPI_ASSISTANT_REQUEST back
//    to 0/unset. Vapi immediately goes back to using the fallback
//    assistant with zero further action needed.
//
// vapiSync.js (the weekly dashboard-assistant push) keeps running
// unchanged — it's what keeps that fallback assistant's knowledge fresh,
// belt-and-suspenders for whenever the flag is off or Vapi falls back.
const fs = require("fs");
const path = require("path");
const { load } = require("./store");
const { instance, profile, instanceDir } = require("./instance");
const { buildReceptionistPrompt, learnedKnowledgeSection } = require("./vapiSync");

/* ------------------------------ profile rendering -------------------------
   Three small, focused renderers — one per AUTO marker — deliberately
   separate from agents.js's instanceKnowledgeBlock() (which produces one
   combined block for the catalog-agent prompt use case): a hand-authored
   vapi-system-prompt.md wants menu/hours/policies placeable at different
   points in its own narrative, not one glob. */
function renderMenu(p) {
  if (!p.services?.length) return "";
  const lines = p.services.map((s) => {
    const detail = [s.price, s.duration].filter(Boolean).join(", ");
    const mods = s.modifiers?.length ? ` — ${s.modifiers.join(", ")}` : "";
    return `- ${s.name}${detail ? " — " + detail : ""}${mods}`;
  });
  return `## Menu\n${lines.join("\n")}`;
}

function renderHours(p) {
  if (!p.hours?.length) return "";
  const where = [p.address, p.publicPhone].filter(Boolean).join(" · ");
  const lines = p.hours.map((h) => `- ${h.days}: ${h.open && h.close ? `${h.open} – ${h.close}` : "Closed"}`);
  return `## Hours\n${where ? where + "\n" : ""}${lines.join("\n")}`;
}

function renderPolicies(p) {
  const lines = [];
  if (p.policies?.length) lines.push(...p.policies.map((x) => `- ${x}`));
  if (p.insuranceAccepted?.length) lines.push(`- Insurance accepted: ${p.insuranceAccepted.join(", ")}`);
  if (p.selfPay) lines.push(`- ${p.selfPay}`);
  if (p.aiDisclosure) lines.push(`- ${p.aiDisclosure}`);
  return lines.length ? `## Policies\n${lines.join("\n")}` : "";
}

const AUTO_RENDERERS = { MENU: renderMenu, HOURS: renderHours, POLICIES: renderPolicies };

// Replaces every <!-- AUTO:X --> marker present with its rendered section.
// If NONE of the three markers appear anywhere in the file (an
// un-migrated instance file), appends all non-empty sections at the end
// under clear headings instead — degrades instead of silently dropping
// profile content.
function applyAutoMarkers(body, p) {
  let out = body;
  let matchedAny = false;
  for (const key of Object.keys(AUTO_RENDERERS)) {
    const marker = `<!-- AUTO:${key} -->`;
    if (out.includes(marker)) {
      matchedAny = true;
      out = out.split(marker).join(AUTO_RENDERERS[key](p));
    }
  }
  if (!matchedAny) {
    const appended = Object.keys(AUTO_RENDERERS).map((k) => AUTO_RENDERERS[k](p)).filter(Boolean).join("\n\n");
    if (appended) out = `${out}\n\n${appended}`;
  }
  return out;
}

// instances/<id>/vapi-system-prompt.md's header is operator instructions
// ("paste everything below the line into...") for the manual dashboard-
// paste workflow — not meant to be sent to the model. Real content starts
// after the first "---" line; falls back to the whole file if that
// separator isn't present.
function stripOperatorHeader(raw) {
  const idx = raw.indexOf("\n---\n");
  return idx === -1 ? raw : raw.slice(idx + 5);
}

/* ------------------------------ prompt composer ---------------------------
   (a) instances/<id>/vapi-system-prompt.md (AUTO markers applied) when that
   file exists — today, The Burg. Falls back to the exact same
   buildReceptionistPrompt(db) that vapiSync.js already pushes to the
   dashboard assistant when it doesn't — today, Shine Dental — so
   assistant-request output never drifts from what the fallback assistant
   already knows for instances that haven't adopted a dedicated file.
   (b) approved faq_gap/policy_correction memory facts, via the SAME
   learnedKnowledgeSection() vapiSync.js uses — shared, not duplicated. */
function composeSystemPromptUncached() {
  const db = load();
  const mdPath = path.join(instanceDir, "vapi-system-prompt.md");
  let body;
  if (fs.existsSync(mdPath)) {
    const raw = fs.readFileSync(mdPath, "utf8");
    body = applyAutoMarkers(stripOperatorHeader(raw), profile).trim();
  } else {
    return buildReceptionistPrompt(db); // already includes learned knowledge
  }
  const learned = learnedKnowledgeSection(db);
  return learned ? `${body}\n\n${learned}` : body;
}

// Cached — constraint is <300ms with no disk reads per request. Invalidated
// on memory approval (server.js's /api/memory/:id/approve) and implicitly
// on every boot (module-level state starts null on process start).
let cachedPrompt = null;
function composeSystemPrompt() {
  if (cachedPrompt === null) cachedPrompt = composeSystemPromptUncached();
  return cachedPrompt;
}
function invalidatePromptCache() {
  cachedPrompt = null;
}

/* ------------------------------ tool schemas -------------------------------
   NOTE: shaped from Vapi's documented function-tool pattern, not yet
   exercised against a live assistant-request call in this repo — same
   caveat vapiSync.js's own PATCH body already carries for its API call.
   Confirm this exact shape against Vapi's current docs (or a sandbox
   assistant) before relying on it in production; the argument NAMES below
   are what matters most and are verified exact matches against the
   /webhooks/vapi tool-calls handlers in server.js. */
const TOOL_SCHEMAS = {
  check_availability: {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check open appointment slots for a given date and service.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to check, e.g. 2026-08-01 or a relative phrase like 'tomorrow'." },
          service: { type: "string", description: "The service/appointment type being asked about." },
        },
        required: ["date"],
      },
    },
  },
  save_contact: {
    type: "function",
    function: {
      name: "save_contact",
      description: "Save the caller as a lead even if they don't book. Always call this before hanging up on a call that didn't end in a booking.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's name." },
          phone: { type: "string", description: "Caller's callback number." },
          service: { type: "string", description: "What they were interested in, if mentioned." },
        },
        required: ["phone"],
      },
    },
  },
  book_appointment: {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book a confirmed appointment slot. Only call after the caller has explicitly agreed to one specific date and time.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          time: { type: "string", description: "e.g. '2:30 PM'." },
          name: { type: "string" },
          phone: { type: "string" },
          service: { type: "string" },
        },
        required: ["date", "time", "name", "phone"],
      },
    },
  },
  place_order: {
    type: "function",
    function: {
      name: "place_order",
      description: "Place the caller's confirmed pickup order. Only call after reading back the full order, total, and pickup time and getting explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          phone: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                qty: { type: "number" },
                modifiers: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          },
          notes: { type: "string" },
          allergy: { type: "string", description: "Verbatim allergy text spoken by the caller — omit entirely if none mentioned." },
        },
        required: ["customer_name", "phone", "items"],
      },
    },
  },
};

const TOOLS_BY_VERTICAL = {
  restaurant: ["place_order"],
};
const DEFAULT_TOOLS = ["check_availability", "book_appointment", "save_contact"]; // clinic and every other vertical

function toolsForVertical(vertical) {
  const names = TOOLS_BY_VERTICAL[vertical] || DEFAULT_TOOLS;
  return names.map((n) => TOOL_SCHEMAS[n]);
}

// End-of-call structured-data extraction — server.js's end-of-call-report
// handler already reads analysis.structuredData.outcome and
// .unansweredQuestions (see the "Coverage-gap learning" comment there);
// this is what tells Vapi's own analysis step to actually populate them.
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["booked", "callback", "not_interested", "completed"],
      description: "How the call ended.",
    },
    unansweredQuestions: {
      type: "array",
      items: { type: "string" },
      description: "Any question the assistant genuinely couldn't answer from its prompt and said so honestly instead of guessing.",
    },
  },
};

/* ------------------------------ assistant config --------------------------
   vapi block in instance.json is optional — instances/_template/
   instance.json documents the shape; any field left out falls back to the
   default here. baseUrl comes from the request (req.protocol + req.get
   ("host")) since this module has no Express req of its own — keeps it
   pure/testable. */
const DEFAULT_VOICE = { provider: "11labs", voiceId: "burt" };
const DEFAULT_MODEL = { provider: "anthropic", model: "claude-3-5-sonnet-20241022" };

function composeAssistantConfig(baseUrl) {
  const vapiCfg = instance.vapi || {};
  const firstMessage = vapiCfg.firstMessage || `Thanks for calling ${instance.name || "us"} — how can I help?`;
  const voice = vapiCfg.voice || DEFAULT_VOICE;
  const model = vapiCfg.model || DEFAULT_MODEL;
  return {
    firstMessage,
    model: {
      ...model,
      messages: [{ role: "system", content: composeSystemPrompt() }],
      tools: toolsForVertical(instance.vertical),
    },
    voice,
    serverUrl: `${baseUrl}/webhooks/vapi`,
    serverUrlSecret: process.env.VAPI_SERVER_SECRET || undefined,
    analysisPlan: {
      structuredDataSchema: ANALYSIS_SCHEMA,
    },
  };
}

module.exports = {
  composeSystemPrompt,
  invalidatePromptCache,
  composeAssistantConfig,
  toolsForVertical,
  ANALYSIS_SCHEMA,
};
