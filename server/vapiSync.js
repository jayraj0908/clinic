// Pushes the owner-approved "learned knowledge" into the live phone
// assistant's system prompt. This is the one place anything ever reaches
// what the AI says on a real call as a result of the librarian's work — and
// it only ever runs after a human has approved the underlying facts
// (server.js's /api/memory/:id/approve route). Nothing here bypasses that.
//
// Dry-run is the default (VAPI_SYNC_DRY_RUN unset or anything other than
// "0") — it composes and logs the prompt without calling Vapi at all. Flip
// VAPI_SYNC_DRY_RUN=0 only once you've reviewed a few dry-run log lines and
// are ready for real pushes to reach the live inbound assistant.
const crypto = require("crypto");
const { load, save, log } = require("./store");
const { systemPromptFor } = require("./agents");

// (a) engine base brain/agents/receptionist.md body, (b) instance profile
// rendered to prose, (c) approved faq_gap/policy_correction facts in a
// clearly marked section — all via the same systemPromptFor() every other
// agent's prompt is built from, so this never drifts from that pattern.
function buildReceptionistPrompt(db) {
  const approved = (db.memory || []).filter(
    (m) => m.status === "approved" && (m.type === "faq_gap" || m.type === "policy_correction")
  );
  const learnedSection = approved.length
    ? `## Learned knowledge (owner-approved — do not contradict this)\n${approved.map((f) => `- ${f.fact}`).join("\n")}`
    : "";
  return systemPromptFor("receptionist", learnedSection);
}

function isDryRun() {
  return process.env.VAPI_SYNC_DRY_RUN !== "0";
}

function hasVapiConfig() {
  return !!(process.env.VAPI_API_KEY && process.env.VAPI_INBOUND_ASSISTANT_ID);
}

// Never include the actual key value in any log line, console output, or
// stored record — only ever a boolean "was it configured".
async function syncToVapi(pushedBy) {
  const db = load();
  const prompt = buildReceptionistPrompt(db);
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  const last = db.promptVersions[db.promptVersions.length - 1];
  if (last && last.hash === hash && !last.dryRun) {
    log("system", "Vapi sync: knowledge unchanged since the last live push — skipped");
    return { skipped: true, reason: "unchanged" };
  }

  const versionNum = db.promptVersions.length + 1;

  if (isDryRun()) {
    console.log(`[vapiSync DRY RUN] Would push v${versionNum} (hash ${hash}) — VAPI_SYNC_DRY_RUN=0 to go live:\n${prompt}`);
    log("system", `Vapi sync (dry run): composed knowledge v${versionNum} — not pushed. Set VAPI_SYNC_DRY_RUN=0 when ready to go live.`);
    db.promptVersions.push({ ts: new Date().toISOString(), hash, prompt, pushedBy: pushedBy || "system", dryRun: true });
    save();
    return { dryRun: true, version: versionNum, hash };
  }

  if (!hasVapiConfig()) {
    log("system", "Vapi sync skipped — VAPI_API_KEY or VAPI_INBOUND_ASSISTANT_ID is not set.");
    return { skipped: true, reason: "not configured" };
  }

  try {
    // Vapi's assistant-update API: PATCH /assistant/{id}, updating the
    // model's system message. Confirm this exact shape against Vapi's
    // current docs / a sandbox assistant before the first real
    // VAPI_SYNC_DRY_RUN=0 push — it's implemented from the documented
    // pattern, not yet exercised against a live assistant in this repo.
    //
    // Coverage-gap learning (server.js's end-of-call-report handler reads
    // analysis.structuredData.unansweredQuestions) depends on a SEPARATE
    // piece of Vapi-side config this PATCH does not manage: the assistant's
    // analysisPlan.structuredDataSchema needs an `unansweredQuestions`
    // string-array property declared (Vapi dashboard → assistant →
    // Analysis, or the equivalent API field) so Vapi's own end-of-call
    // analysis actually extracts and returns it — the system prompt
    // instructs the model to flag them, but Vapi's structured-data
    // extraction is a distinct step that needs its own schema entry.
    const res = await fetch(`https://api.vapi.ai/assistant/${process.env.VAPI_INBOUND_ASSISTANT_ID}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: { messages: [{ role: "system", content: prompt }] } }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log("error", `Vapi sync failed: HTTP ${res.status}${errText ? " — " + errText.slice(0, 200) : ""}`);
      return { ok: false, status: res.status };
    }
    db.promptVersions.push({ ts: new Date().toISOString(), hash, prompt, pushedBy: pushedBy || "system" });
    save();
    log("system", `Vapi sync: pushed knowledge v${versionNum} (${hash}) — ${pushedBy || "system"}`);
    return { ok: true, version: versionNum, hash };
  } catch (e) {
    log("error", `Vapi sync error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Multiple memory approvals in quick succession should trigger one sync,
// not one push per approval — debounced 5 minutes from the last approval.
let debounceTimer = null;
function scheduleSyncDebounced(pushedBy) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    syncToVapi(pushedBy).catch((e) => log("error", `Debounced Vapi sync failed: ${e.message}`));
  }, 5 * 60 * 1000);
}

module.exports = { buildReceptionistPrompt, syncToVapi, scheduleSyncDebounced, isDryRun, hasVapiConfig };
