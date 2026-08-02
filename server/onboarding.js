// Client self-service onboarding wizard — backend logic. The wizard NEVER
// writes live config directly: everything it collects lands in
// db.onboardings[].data (per-step answers) and, once the client reaches the
// end, db.onboardings[].draft (assembled instance/profile/messages/memory
// JSON) — a Sailz owner reviews and explicitly activates before any of it
// touches instances/<slug>/ on disk. Same human-gate philosophy as the
// librarian/memory approval flow.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nanoid } = require("nanoid");
const { load, save, log, DB_PATH } = require("./store");
const notify = require("./notify");
const { parseFrontmatter, AGENTS } = require("./brain");

const hasKey = (k) => !!process.env[k];

const STEP_ORDER = ["basics", "hours", "services", "policies", "brainDump", "voice", "interview", "done"];
const MAX_INTERVIEW_QUESTIONS = 8;
const INSTANCES_DIR = path.join(__dirname, "..", "instances");
const ENGINE_RECEPTIONIST_MD = path.join(__dirname, "..", "brain", "agents", "receptionist.md");

// Upload limits enforced server-side too (not just multer's per-request
// checks in server.js) since a total cap has to span multiple batches —
// see runBrainDump's running-total check below.
const MAX_FILES_PER_BATCH = 20;
const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024;
// Per-file cap on how much extracted text db.json retains — keeps a giant
// PDF from bloating storage forever; structureBrainDump further caps the
// combined corpus at 40k chars regardless.
const MAX_STORED_TEXT_CHARS = 20000;

// Raw bytes for image/audio uploads land on disk (never just in memory/db.json)
// so a human can open the actual photo/recording later — text-extractable
// types (.txt/.pdf/.docx) don't need this, their content is already fully
// captured as extracted text. Lives next to db.json so it's on the same
// persistent volume in production (see server/store.js's DB_PATH).
const UPLOADS_ROOT = path.join(path.dirname(DB_PATH), "uploads", "onboarding");
function saveUploadToDisk(onboardingId, file) {
  const dir = path.join(UPLOADS_ROOT, onboardingId);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname || "").toLowerCase()}`;
  fs.writeFileSync(path.join(dir, safeName), file.buffer);
  return path.relative(path.dirname(DB_PATH), path.join(dir, safeName));
}

// The review screen's starting checkbox state, per vertical — matches
// instances/_template/instance.json's own recommendedAgents convention.
// The owner can add/remove before activating; whatever's left checked
// becomes the new instance's instance.json "agents" field (server/
// catalog.js's fallback active set — see server/brain.js's loadAgents()).
const VERTICAL_RECOMMENDED_AGENTS = {
  dental: ["receptionist", "leads", "calling", "audit", "billing", "librarian"],
  restaurant: ["receptionist", "librarian"],
};
const DEFAULT_RECOMMENDED_AGENTS = ["receptionist", "leads", "librarian"];

function recommendedAgentsFor(vertical) {
  const list = VERTICAL_RECOMMENDED_AGENTS[vertical] || DEFAULT_RECOMMENDED_AGENTS;
  return list.filter((id) => AGENTS[id]); // only ids the engine's catalog actually has
}

function emptyStepData() {
  return {
    basics: {},
    hours: {},
    services: [],
    policies: {},
    brainDump: { text: "", files: [], extractedProfile: null, proposedFacts: [] },
    voice: {},
    interview: { qas: [] },
  };
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "client";
}

function slugTaken(slug) {
  if (fs.existsSync(path.join(INSTANCES_DIR, slug))) return true;
  const db = load();
  return db.onboardings.some((o) => o.draft?.instanceJson?.id === slug && o.status === "activated");
}

function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 2;
  while (slugTaken(slug)) {
    slug = `${slugify(base)}-${n}`;
    n++;
  }
  return slug;
}

// ---------- token lifecycle ----------

function createOnboarding({ clientName, createdBy }) {
  const db = load();
  const entry = {
    id: "OB" + nanoid(10),
    token: nanoid(32),
    clientName: clientName || "New client",
    status: "sent", // sent -> in_progress -> completed -> activated
    createdAt: new Date().toISOString(),
    createdBy,
    updatedAt: new Date().toISOString(),
    currentStep: STEP_ORDER[0],
    data: emptyStepData(),
    draft: null,
  };
  db.onboardings.push(entry);
  save();
  log("system", `${createdBy} created an onboarding link for ${entry.clientName}`);
  return entry;
}

// A token is usable while status is "sent" or "in_progress" — once the
// client finishes (status "completed") or it's been activated, the link is
// spent. Owner review/activation from then on happens via the internal id,
// never the public token.
function findLiveByToken(token) {
  const db = load();
  const o = db.onboardings.find((x) => x.token === token);
  if (!o) return { ok: false, status: 404, error: "This link isn't valid." };
  if (o.status === "completed" || o.status === "activated") {
    return { ok: false, status: 410, error: "This link has already been used." };
  }
  return { ok: true, db, onboarding: o };
}

function publicView(o) {
  return { clientName: o.clientName, status: o.status, currentStep: o.currentStep, data: o.data };
}

function getPublicState(token) {
  const found = findLiveByToken(token);
  if (!found.ok) return found;
  return { ok: true, onboarding: publicView(found.onboarding) };
}

function saveStep(token, step, data) {
  const found = findLiveByToken(token);
  if (!found.ok) return found;
  if (!STEP_ORDER.includes(step)) return { ok: false, status: 400, error: "Unknown step." };
  const { db, onboarding } = found;
  onboarding.data[step] = data;
  onboarding.currentStep = step;
  onboarding.status = "in_progress";
  onboarding.updatedAt = new Date().toISOString();
  save();
  return { ok: true, onboarding: publicView(onboarding) };
}

// ---------- brain dump: file/text extraction + Claude structuring ----------

async function claude(prompt, system, maxTokens = 3000) {
  if (!hasKey("ANTHROPIC_API_KEY")) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system: system || "", messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
  return data.content?.map((c) => c.text || "").join("") || null;
}

function stripJsonFence(s) {
  return String(s || "").replace(/```json|```/g, "").trim();
}

// Structures a pasted/uploaded knowledge dump into clinic-profile fields +
// proposed memory facts. Falls back to a plain "we couldn't auto-read this,
// here's your raw text to review" shape when no ANTHROPIC_API_KEY is set —
// the client's paste is never lost, just not auto-structured.
async function structureBrainDump(corpusText) {
  const trimmed = (corpusText || "").slice(0, 40000); // keep the prompt bounded
  if (!hasKey("ANTHROPIC_API_KEY")) {
    return { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [], unstructuredNote: "Claude isn't connected — review the raw text below and fill in fields manually." };
  }
  if (!trimmed.trim()) {
    return { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [] };
  }
  const out = await claude(
    `A business owner pasted/uploaded the following material (price lists, FAQ docs, training manuals, anything) while setting up their AI phone assistant. Extract what you can into structured fields. Never invent anything not present in the text.\n\n` +
      `Output strict JSON:\n` +
      `{"services":[{"name":"","priceRange":"","duration":""}],"policies":["..."],"insuranceAccepted":["..."],"selfPay":"","hours":[{"days":"Mon–Fri","open":"9:00 AM","close":"5:00 PM"}],"facts":[{"fact":"","source":"brain dump"}]}\n\n` +
      `"facts" = any standalone useful knowledge that doesn't fit the structured fields above (a policy nuance, an FAQ answer, a training note) — one clear sentence each. Omit anything you're not confident is present in the source text.\n\n---\n${trimmed}`,
    "You extract structured business knowledge from raw text. Output ONLY the JSON object, nothing else."
  );
  try {
    const parsed = JSON.parse(stripJsonFence(out));
    return {
      services: Array.isArray(parsed.services) ? parsed.services : [],
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      insuranceAccepted: Array.isArray(parsed.insuranceAccepted) ? parsed.insuranceAccepted : [],
      selfPay: parsed.selfPay || "",
      hours: Array.isArray(parsed.hours) ? parsed.hours : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f && f.fact) : [],
    };
  } catch {
    return { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [], unstructuredNote: "Couldn't parse the brain's structured output — review the raw text below and fill in fields manually." };
  }
}

// A photo of a menu/price list/hour sign should produce the same quality
// draft as pasted text — same output shape as structureBrainDump, sent as a
// Claude vision content block instead of a text corpus. Returns null (never
// throws) on no key, no useful content, or a bad response, so callers just
// fall back to "couldn't read this" rather than needing their own try/catch.
async function extractImageProfile(file) {
  if (!hasKey("ANTHROPIC_API_KEY")) return null;
  const mediaType = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype || "") ? file.mimetype : "image/jpeg";
  let out;
  try {
    out = await claude(
      [
        { type: "image", source: { type: "base64", media_type: mediaType, data: file.buffer.toString("base64") } },
        {
          type: "text",
          text:
            `A business owner photographed this while setting up their AI phone assistant — could be a menu, price list, service board, or hours sign. Extract everything readable into structured fields. Never invent anything not visible in the photo.\n\n` +
            `Output strict JSON:\n` +
            `{"services":[{"name":"","priceRange":"","duration":""}],"policies":["..."],"insuranceAccepted":["..."],"selfPay":"","hours":[{"days":"Mon–Fri","open":"9:00 AM","close":"5:00 PM"}],"facts":[{"fact":"","source":"photo upload"}]}\n\n` +
            `If the photo has no readable business info (blurry, unrelated, upside down beyond recognition), output {"unreadable": true} instead.`,
        },
      ],
      "You read photos of menus, price lists, service boards, and hour signs and extract structured business knowledge. Output ONLY the JSON object, nothing else.",
      2000
    );
  } catch {
    return null;
  }
  if (!out) return null;
  try {
    const parsed = JSON.parse(stripJsonFence(out));
    if (parsed.unreadable) return null;
    const profile = {
      services: Array.isArray(parsed.services) ? parsed.services : [],
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      insuranceAccepted: Array.isArray(parsed.insuranceAccepted) ? parsed.insuranceAccepted : [],
      selfPay: parsed.selfPay || "",
      hours: Array.isArray(parsed.hours) ? parsed.hours : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f && f.fact) : [],
    };
    const summary = [
      profile.services.length ? `Services: ${profile.services.map((s) => `${s.name}${s.priceRange ? ` (${s.priceRange})` : ""}`).join(", ")}` : "",
      profile.hours.length ? `Hours: ${profile.hours.map((h) => `${h.days} ${h.open ? `${h.open}–${h.close}` : "closed"}`).join(", ")}` : "",
      profile.policies.length ? `Policies: ${profile.policies.join(" ")}` : "",
      profile.insuranceAccepted.length ? `Insurance: ${profile.insuranceAccepted.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    if (!summary && !profile.facts.length) return null; // structurally valid but nothing usable — treat like unreadable
    return { profile, text: summary };
  } catch {
    return null;
  }
}

// Optional — DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY (documented in
// .env.example). Returns null (not an error) when neither is configured, so
// callers can tell "no provider" apart from "provider failed" and degrade
// each appropriately. Deepgram answers in one request; AssemblyAI needs an
// upload + poll round-trip, capped so a slow/stuck job can't hang the
// onboarding request forever.
async function transcribeAudio(file) {
  if (hasKey("DEEPGRAM_API_KEY")) {
    const res = await fetch("https://api.deepgram.com/v1/listen?smart_format=true", {
      method: "POST",
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": file.mimetype || "application/octet-stream" },
      body: file.buffer,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.err_msg || `Deepgram error ${res.status}`);
    return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  }
  if (hasKey("ASSEMBLYAI_API_KEY")) {
    const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: { authorization: process.env.ASSEMBLYAI_API_KEY },
      body: file.buffer,
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData.error || `AssemblyAI upload error ${uploadRes.status}`);
    const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: { authorization: process.env.ASSEMBLYAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ audio_url: uploadData.upload_url }),
    });
    const transcriptData = await transcriptRes.json();
    if (!transcriptRes.ok) throw new Error(transcriptData.error || `AssemblyAI error ${transcriptRes.status}`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptData.id}`, {
        headers: { authorization: process.env.ASSEMBLYAI_API_KEY },
      });
      const pollData = await pollRes.json();
      if (pollData.status === "completed") return pollData.text || "";
      if (pollData.status === "error") throw new Error(pollData.error || "AssemblyAI transcription failed");
    }
    throw new Error("Transcription timed out");
  }
  return null;
}

const IMAGE_EXT = /\.(jpe?g|png)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|webm)$/i;

// One file in → one status-chip row out. Never throws — every branch is
// wrapped so a single bad file (corrupt PDF, unreadable photo, a
// transcription API hiccup) fails that file only, with a friendly note,
// instead of taking down the whole batch.
async function processFile(file, onboardingId) {
  const name = file.originalname || "file";
  const ext = path.extname(name).toLowerCase();
  const base = { name, mimetype: file.mimetype || "", size: file.buffer.length };
  try {
    if (ext === ".txt" || file.mimetype === "text/plain") {
      return { ...base, kind: "text", status: "parsed", text: file.buffer.toString("utf8") };
    }
    if (ext === ".pdf" || file.mimetype === "application/pdf") {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(file.buffer);
      return { ...base, kind: "text", status: "parsed", text: data.text || "" };
    }
    if (ext === ".docx" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = require("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: file.buffer });
      return { ...base, kind: "text", status: "parsed", text: value || "" };
    }
    if (HEIC_EXT.test(name)) {
      return { ...base, kind: "image", status: "failed", text: "", note: "HEIC photos aren't supported yet — export it as a JPG first (on iPhone: Settings → Camera → Formats → “Most Compatible”, or just share the photo to Messages/Mail and re-save it) and upload again." };
    }
    if (IMAGE_EXT.test(name) || /^image\//.test(file.mimetype || "")) {
      const storedPath = saveUploadToDisk(onboardingId, file);
      if (!hasKey("ANTHROPIC_API_KEY")) {
        return { ...base, kind: "image", status: "queued", text: "", storedPath, note: "Saved — Claude isn't connected on this deployment yet, so this photo is queued for the Sailz team to read manually." };
      }
      const result = await extractImageProfile(file);
      if (!result) return { ...base, kind: "image", status: "failed", text: "", storedPath, note: "Couldn't make out anything useful in this photo — try a clearer, well-lit shot, or type the details instead." };
      return { ...base, kind: "image", status: "parsed", text: result.text, storedPath, imageProfile: result.profile };
    }
    if (AUDIO_EXT.test(name) || /^audio\//.test(file.mimetype || "")) {
      const storedPath = saveUploadToDisk(onboardingId, file);
      let transcript = null;
      try {
        transcript = await transcribeAudio(file);
      } catch (e) {
        return { ...base, kind: "audio", status: "queued", text: "", storedPath, note: `Saved — transcription failed (${e.message}), queued for the Sailz team to review.` };
      }
      if (transcript === null) {
        return { ...base, kind: "audio", status: "queued", text: "", storedPath, note: "Saved — no transcription service is connected on this deployment yet, so this recording is queued for the Sailz team to review." };
      }
      return { ...base, kind: "audio", status: "parsed", text: transcript, storedPath, note: transcript.trim() ? null : "Transcribed, but nothing came through — queued for review just in case." };
    }
    return { ...base, kind: "other", status: "failed", text: "", note: `Unsupported file type: ${name}` };
  } catch (e) {
    return { ...base, kind: "other", status: "failed", text: "", note: `Couldn't read ${name}: ${e.message}` };
  }
}

async function runBrainDump(token, { text, files }) {
  const found = findLiveByToken(token);
  if (!found.ok) return found;
  const { onboarding } = found;

  const incoming = (files || []).slice(0, MAX_FILES_PER_BATCH);
  const existingFiles = onboarding.data.brainDump?.files || [];
  const existingBytes = existingFiles.reduce((sum, f) => sum + (f.size || 0), 0);
  const incomingBytes = incoming.reduce((sum, f) => sum + (f.buffer?.length || 0), 0);
  if (existingBytes + incomingBytes > MAX_TOTAL_UPLOAD_BYTES) {
    const usedMB = Math.round(existingBytes / 1024 / 1024);
    return { ok: false, status: 400, error: `That would put this onboarding over the 200MB total upload limit (${usedMB}MB already uploaded) — remove a file or two and try again.` };
  }

  const processed = [];
  for (const f of incoming) processed.push(await processFile(f, onboarding.id));
  // existingFiles already carry a (possibly truncated) .text from a prior
  // batch's save below — re-used as-is so the corpus stays cumulative across
  // batches instead of only reflecting whatever was just uploaded.
  const allFiles = [...existingFiles, ...processed];

  const parsedText = allFiles.filter((f) => f.status === "parsed" && f.text).map((f) => `\n\n[From ${f.name}]\n${f.text}`).join("\n");
  const corpus = [text || "", parsedText].join("\n").trim();

  const extractedProfile = await structureBrainDump(corpus);
  // Images return their own structured facts directly (a photo of a menu
  // shouldn't depend on structureBrainDump re-parsing a plain-text summary
  // of itself to surface its facts) — folded in alongside whatever
  // structureBrainDump found in the combined text corpus.
  const imageFacts = allFiles.filter((f) => f.kind === "image" && f.imageProfile?.facts?.length).flatMap((f) => f.imageProfile.facts);

  onboarding.data.brainDump = {
    text: text || "",
    // .text kept (capped) per file — needed so the NEXT batch's corpus can
    // still include earlier batches' extracted text; structureBrainDump
    // itself further caps the combined corpus at 40k chars.
    files: allFiles.map((f) => ({
      name: f.name, mimetype: f.mimetype, size: f.size, kind: f.kind, status: f.status,
      text: (f.text || "").slice(0, MAX_STORED_TEXT_CHARS),
      chars: f.text ? f.text.length : 0, note: f.note || null, storedPath: f.storedPath || null,
    })),
    extractedProfile,
    proposedFacts: [...(extractedProfile.facts || []), ...imageFacts],
  };
  onboarding.status = "in_progress";
  onboarding.currentStep = "brainDump";
  onboarding.updatedAt = new Date().toISOString();
  save();
  return { ok: true, onboarding: publicView(onboarding) };
}

// ---------- interview: adaptive follow-up questions ----------

function profileSoFarText(onboarding) {
  const d = onboarding.data;
  const lines = [];
  if (d.basics?.businessName) lines.push(`Business: ${d.basics.businessName} (${d.basics.businessType || "unspecified type"})`);
  if (d.hours && Object.keys(d.hours).length) lines.push(`Hours: ${JSON.stringify(d.hours)}`);
  if (d.services?.length) lines.push(`Services: ${d.services.map((s) => `${s.name} (${s.priceRange || "?"}, ${s.duration || "?"})`).join("; ")}`);
  if (d.policies && Object.keys(d.policies).length) lines.push(`Policies: ${JSON.stringify(d.policies)}`);
  if (d.brainDump?.extractedProfile) lines.push(`From brain dump: ${JSON.stringify(d.brainDump.extractedProfile)}`);
  if (d.voice && Object.keys(d.voice).length) lines.push(`Voice/tone: ${JSON.stringify(d.voice)}`);
  return lines.join("\n") || "(nothing collected yet)";
}

// Returns {question} for the next adaptive question, or {done:true} once
// MAX_INTERVIEW_QUESTIONS is reached or Claude signals no more real gaps.
// answers is the running [{q,a}] list including whatever the client just
// answered — persisted here so the wizard is resumable mid-interview too.
async function nextInterviewQuestion(token, { answers }) {
  const found = findLiveByToken(token);
  if (!found.ok) return found;
  const { onboarding } = found;

  const qas = Array.isArray(answers) ? answers.slice(0, MAX_INTERVIEW_QUESTIONS) : [];
  onboarding.data.interview = { qas };
  onboarding.currentStep = "interview";
  onboarding.status = "in_progress";
  onboarding.updatedAt = new Date().toISOString();
  save();

  if (qas.length >= MAX_INTERVIEW_QUESTIONS) return { ok: true, done: true };
  if (!hasKey("ANTHROPIC_API_KEY")) return { ok: true, done: true };

  const answeredSoFar = qas.map((qa, i) => `Q${i + 1}: ${qa.q}\nA${i + 1}: ${qa.a}`).join("\n\n");
  const out = await claude(
    `You're a careful intake interviewer for a new AI phone-assistant client. Here's what's been collected so far:\n\n${profileSoFarText(onboarding)}\n\n` +
      (answeredSoFar ? `Already asked in this interview:\n${answeredSoFar}\n\n` : "") +
      `Ask ONE more short, specific follow-up question about a real gap you notice (something a caller would likely ask that isn't covered yet — e.g. "You mentioned implants — do you offer free consultations for those?"). ` +
      `If there's genuinely nothing important left to ask, or you've asked enough good questions already, say so instead.\n\n` +
      `Output strict JSON: {"done": false, "question": "..."} or {"done": true}.`,
    "You ask exactly one focused question at a time. Never repeat a question already asked. Output ONLY the JSON object."
  );
  try {
    const parsed = JSON.parse(stripJsonFence(out));
    if (parsed.done || !parsed.question) return { ok: true, done: true };
    return { ok: true, done: false, question: parsed.question };
  } catch {
    return { ok: true, done: true };
  }
}

// ---------- completion: assemble the draft ----------

function buildDraftFromOnboarding(onboarding) {
  const d = onboarding.data;
  const basics = d.basics || {};
  const bd = d.brainDump?.extractedProfile || {};
  const slug = uniqueSlug(basics.businessName || onboarding.clientName);

  // Structured fields the client filled in directly win over anything the
  // brain dump guessed at the same field — a human's explicit answer beats
  // an inference from unstructured text every time.
  const hours = (Array.isArray(d.hours?.rows) && d.hours.rows.length ? d.hours.rows : bd.hours) || [];
  const services = (d.services?.length ? d.services : bd.services || []).map((s) => ({
    name: s.name || "", price: s.priceRange || s.price || "", duration: s.duration || "",
  }));
  const insuranceAccepted = d.policies?.insuranceAccepted?.length ? d.policies.insuranceAccepted : bd.insuranceAccepted || [];
  const selfPay = d.policies?.paymentOptions || bd.selfPay || "";
  const policies = [
    d.policies?.cancellationPolicy,
    ...(bd.policies || []),
  ].filter(Boolean);

  const vertical = (basics.businessType || "dental").toLowerCase();
  const instanceJson = {
    id: slug,
    name: basics.businessName || onboarding.clientName,
    vertical,
    brandColor: "#c9a066",
    timezone: basics.timezone || "America/New_York",
    // Pre-checked per vertical on the review screen; the owner adjusts
    // there before activating. See server/catalog.js's getActiveAgentIds —
    // this becomes the new instance's default active set on first boot.
    agents: recommendedAgentsFor(vertical),
  };

  const clinicProfileJson = {
    name: instanceJson.name,
    timezone: instanceJson.timezone,
    hours: hours.length ? hours : [{ days: "Mon–Fri", open: "9:00 AM", close: "5:00 PM" }, { days: "Sat", open: null, close: null }, { days: "Sun", open: null, close: null }],
    services: services.length ? services : [{ name: "Example service — replace me", price: "$0–$0", duration: "0 min" }],
    insuranceAccepted,
    selfPay: selfPay || "Describe accepted payment methods here.",
    policies: policies.length ? policies : ["Cancellation/rescheduling policy goes here."],
    aiDisclosure: "This call may be handled by an AI assistant. State this at the start of every call where required by law — verify per-state/per-country requirements before launch.",
  };

  if (d.hours?.holidaysNote) clinicProfileJson.policies.push(`Holidays: ${d.hours.holidaysNote}`);

  const messagesJson = {
    bookingConfirmationSMS: `You're booked at {clinic} — {service}, {date} {time}. Reply here or call {number} to reschedule.`,
    bookingConfirmationEmailSubject: `Your appointment at {clinic} is confirmed`,
    bookingConfirmationEmailHTML: `<p>Hi {patient},</p><p>You're booked at <strong>{clinic}</strong> — {service}, {date} {time}.</p><p>Reply to this email or call {number} to reschedule.</p>`,
    reminderSMS: `Reminder: you have an appointment at {clinic} tomorrow — {service}, {date} {time}. Call {number} if you need to reschedule.`,
  };
  if (basics.greeting) messagesJson._greetingNote = basics.greeting; // preserved for reviewer context, not a runtime key

  const memoryFacts = [
    ...(d.brainDump?.proposedFacts || []).map((f) => ({ type: "policy_correction", fact: f.fact, source: f.source || "onboarding brain dump" })),
    ...(d.interview?.qas || []).filter((qa) => qa.a && qa.a.trim()).map((qa) => ({ type: "policy_correction", fact: `${qa.q} — ${qa.a}`, source: "onboarding interview" })),
  ];

  const neverSay = (d.voice?.neverSay || "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  if (d.voice?.formality || d.voice?.greetingPhrasing || neverSay.length) {
    const bits = [];
    if (d.voice.formality) bits.push(`Tone should be ${d.voice.formality}.`);
    if (d.voice.greetingPhrasing) bits.push(`Greet callers with something like: "${d.voice.greetingPhrasing}"`);
    if (neverSay.length) bits.push(`Never say: ${neverSay.join("; ")}.`);
    memoryFacts.push({ type: "policy_correction", fact: bits.join(" "), source: "onboarding voice & tone" });
  }

  return { instanceJson, clinicProfileJson, messagesJson, memoryFacts };
}

async function completeOnboarding(token) {
  const found = findLiveByToken(token);
  if (!found.ok) return found;
  const { onboarding } = found;

  onboarding.draft = buildDraftFromOnboarding(onboarding);
  onboarding.status = "completed";
  onboarding.currentStep = "done";
  onboarding.completedAt = new Date().toISOString();
  onboarding.updatedAt = new Date().toISOString();
  save();

  log("system", `Onboarding complete: ${onboarding.clientName} — draft ready for review (${onboarding.draft.memoryFacts.length} proposed fact(s))`);
  const notifyTo = process.env.SAILZ_NOTIFY_EMAIL;
  if (notifyTo) {
    notify.sendEmail(
      notifyTo,
      `Onboarding ready to review: ${onboarding.clientName}`,
      `<p><strong>${onboarding.clientName}</strong> finished the onboarding wizard.</p><p>Draft slug: <code>${onboarding.draft.instanceJson.id}</code> — ${onboarding.draft.memoryFacts.length} proposed memory fact(s).</p><p>Review and activate from the owner dashboard.</p>`
    ).catch((e) => log("notify", `Onboarding-ready email error: ${e.message}`));
  } else {
    log("notify", "Onboarding-ready email skipped — SAILZ_NOTIFY_EMAIL not configured");
  }

  return { ok: true, onboarding: publicView(onboarding) };
}

// ---------- owner review + activation ----------

function listOnboardings() {
  const db = load();
  return db.onboardings
    .map((o) => ({ id: o.id, clientName: o.clientName, status: o.status, currentStep: o.currentStep, createdAt: o.createdAt, updatedAt: o.updatedAt, slug: o.draft?.instanceJson?.id || null }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function getById(id) {
  const db = load();
  return db.onboardings.find((o) => o.id === id) || null;
}

function templateReference() {
  const dir = path.join(INSTANCES_DIR, "_template");
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  return { instanceJson: read("instance.json"), clinicProfileJson: read("clinic-profile.json"), messagesJson: read("messages.json") };
}

// The full engine catalog (every agent that could ever be offered — this
// new instance has no overrides of its own yet), for the review screen's
// agent-picker checkboxes. Deliberately just id/name/tagline/requires —
// the review screen isn't the live catalog UI, it doesn't need state/
// activation machinery, just enough to label a checkbox honestly.
function engineCatalogSummary() {
  return Object.values(AGENTS)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((a) => ({ id: a.id, name: a.displayName, tagline: a.tagline, requires: a.requires }));
}

function getForReview(id) {
  const o = getById(id);
  if (!o) return null;
  return { ...o, template: templateReference(), engineCatalog: engineCatalogSummary() };
}

function updateDraft(id, patch) {
  const db = load();
  const o = db.onboardings.find((x) => x.id === id);
  if (!o) return { ok: false, status: 404, error: "Onboarding not found." };
  if (!o.draft) return { ok: false, status: 400, error: "This onboarding has no draft yet — the client hasn't completed the wizard." };
  if (patch.instanceJson) o.draft.instanceJson = { ...o.draft.instanceJson, ...patch.instanceJson };
  if (patch.clinicProfileJson) o.draft.clinicProfileJson = { ...o.draft.clinicProfileJson, ...patch.clinicProfileJson };
  if (patch.messagesJson) o.draft.messagesJson = { ...o.draft.messagesJson, ...patch.messagesJson };
  if (Array.isArray(patch.memoryFacts)) o.draft.memoryFacts = patch.memoryFacts;
  o.updatedAt = new Date().toISOString();
  save();
  return { ok: true, onboarding: o };
}

// Composes a preview of the new instance's receptionist prompt — mirrors
// vapiSync.buildReceptionistPrompt()'s shape exactly (engine body + business
// knowledge + learned-knowledge section) but operates on the DRAFT's own
// data rather than this process's live instance/profile/AGENTS singletons,
// since the new instance doesn't exist as a running deployment yet. Preview
// only — never pushed anywhere.
function buildDraftPromptPreview(draft) {
  let engineBody = `You are the front-desk receptionist for ${draft.instanceJson.name}.`;
  try {
    const raw = fs.readFileSync(ENGINE_RECEPTIONIST_MD, "utf8");
    engineBody = parseFrontmatter(raw).body;
  } catch { /* fall back to the generic line above */ }

  const p = draft.clinicProfileJson;
  const lines = [];
  if (p.hours?.length) lines.push("Hours: " + p.hours.map((h) => `${h.days} ${h.open ? `${h.open}–${h.close}` : "closed"}`).join(", "));
  if (p.services?.length) lines.push("Services: " + p.services.map((s) => [s.name, [s.price, s.duration].filter(Boolean).join(", ")].filter(Boolean).join(" — ")).join("; "));
  if (p.insuranceAccepted?.length) lines.push("Insurance accepted: " + p.insuranceAccepted.join(", "));
  if (p.selfPay) lines.push("Self-pay: " + p.selfPay);
  if (p.policies?.length) lines.push("Policies: " + p.policies.join(" "));
  const knowledge = lines.join("\n");

  const facts = draft.memoryFacts || [];
  const learned = facts.length ? `## Learned knowledge (owner-approved — do not contradict this)\n${facts.map((f) => `- ${f.fact}`).join("\n")}` : "";

  return [engineBody, knowledge ? `## Business knowledge\n${knowledge}` : "", learned].filter(Boolean).join("\n\n").trim();
}

async function activateOnboarding(id, activatedBy) {
  const db = load();
  const o = db.onboardings.find((x) => x.id === id);
  if (!o) return { ok: false, status: 404, error: "Onboarding not found." };
  if (!o.draft) return { ok: false, status: 400, error: "No draft to activate — the client hasn't completed the wizard." };
  if (o.status === "activated") return { ok: false, status: 409, error: "Already activated." };

  const slug = o.draft.instanceJson.id;
  const dir = path.join(INSTANCES_DIR, slug);
  if (fs.existsSync(dir)) return { ok: false, status: 409, error: `instances/${slug}/ already exists — pick a different slug before activating.` };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify(o.draft.instanceJson, null, 2));
  fs.writeFileSync(path.join(dir, "clinic-profile.json"), JSON.stringify(o.draft.clinicProfileJson, null, 2));
  fs.writeFileSync(path.join(dir, "messages.json"), JSON.stringify(o.draft.messagesJson, null, 2));
  if (o.draft.memoryFacts?.length) {
    fs.writeFileSync(path.join(dir, "onboarding-memory-seed.json"), JSON.stringify(o.draft.memoryFacts, null, 2));
  }

  let promptPreview = null;
  if (hasKey("VAPI_API_KEY")) {
    promptPreview = buildDraftPromptPreview(o.draft);
    const hash = crypto.createHash("sha256").update(promptPreview).digest("hex").slice(0, 12);
    console.log(`[onboarding dry-run] ${slug} receptionist prompt (${hash}):\n${promptPreview}`);
  }

  o.status = "activated";
  o.activatedAt = new Date().toISOString();
  o.activatedBy = activatedBy;
  o.updatedAt = new Date().toISOString();
  save();

  log("system", `${activatedBy} activated instances/${slug}/ for ${o.clientName}`);
  const notifyTo = process.env.SAILZ_NOTIFY_EMAIL;
  if (notifyTo) {
    notify.sendEmail(
      notifyTo,
      `Activated: ${o.clientName}`,
      `<p><strong>${o.clientName}</strong> is now live at <code>instances/${slug}/</code>.</p><p>Next: deploy a new service pointed at INSTANCE=${slug} with that client's own env vars.</p>`
    ).catch((e) => log("notify", `Activation email error: ${e.message}`));
  }

  return { ok: true, slug, promptPreview };
}

module.exports = {
  STEP_ORDER,
  createOnboarding,
  getPublicState,
  saveStep,
  runBrainDump,
  nextInterviewQuestion,
  completeOnboarding,
  listOnboardings,
  getForReview,
  getById,
  updateDraft,
  activateOnboarding,
  slugify,
};
