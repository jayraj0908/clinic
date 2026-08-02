// Shared file/text ingestion pipeline — the same "turn anything into
// structured knowledge" machinery used by both the onboarding wizard
// (server/onboarding.js) and the post-onboarding "Teach Your Brain" surface
// (server.js's /api/teach/upload). One place for Claude text/vision calls,
// transcription, and on-disk storage so the two callers can never drift.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DB_PATH } = require("./store");

const hasKey = (k) => !!process.env[k];

// Per-file cap on how much extracted text db.json retains — keeps a giant
// PDF from bloating storage forever; structureCorpus further caps the
// combined corpus at 40k chars regardless.
const MAX_STORED_TEXT_CHARS = 20000;

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

// Structures pasted/uploaded knowledge into clinic-profile fields + proposed
// memory facts. Falls back to a plain "we couldn't auto-read this, here's
// your raw text to review" shape when no ANTHROPIC_API_KEY is set — the
// client's paste/upload is never lost, just not auto-structured.
async function structureCorpus(corpusText) {
  const trimmed = (corpusText || "").slice(0, 40000); // keep the prompt bounded
  if (!hasKey("ANTHROPIC_API_KEY")) {
    return { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [], unstructuredNote: "Claude isn't connected — review the raw text below and fill in fields manually." };
  }
  if (!trimmed.trim()) {
    return { services: [], policies: [], insuranceAccepted: [], selfPay: "", hours: [], facts: [] };
  }
  const out = await claude(
    `A business owner pasted/uploaded the following material (price lists, FAQ docs, training manuals, anything) while setting up or teaching their AI phone assistant. Extract what you can into structured fields. Never invent anything not present in the text.\n\n` +
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
// draft as pasted text — same output shape as structureCorpus, sent as a
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
            `A business owner photographed this while setting up or teaching their AI phone assistant — could be a menu, price list, service board, or hours sign. Extract everything readable into structured fields. Never invent anything not visible in the photo.\n\n` +
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
// caller's request forever.
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

// Raw bytes for image/audio uploads land on disk (never just in memory/
// db.json) so a human can open the actual photo/recording later — text-
// extractable types (.txt/.pdf/.docx) don't need this, their content is
// already fully captured as extracted text. Lives next to db.json so it's
// on the same persistent volume in production (see server/store.js's
// DB_PATH). "kind" separates onboarding uploads from Teach uploads on disk;
// "scopeId" further separates by onboarding id or instance id.
const UPLOADS_ROOT = path.join(path.dirname(DB_PATH), "uploads");
function saveUploadToDisk(kind, scopeId, file) {
  const dir = path.join(UPLOADS_ROOT, kind, scopeId);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname || "").toLowerCase()}`;
  fs.writeFileSync(path.join(dir, safeName), file.buffer);
  return path.relative(path.dirname(DB_PATH), path.join(dir, safeName));
}

const IMAGE_EXT = /\.(jpe?g|png)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|webm)$/i;

// One file in → one status-chip row out. Never throws — every branch is
// wrapped so a single bad file (corrupt PDF, unreadable photo, a
// transcription API hiccup) fails that file only, with a friendly note,
// instead of taking down the whole batch. "kind"/"scopeId" — see
// saveUploadToDisk above.
async function processFile(file, kind, scopeId) {
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
      const storedPath = saveUploadToDisk(kind, scopeId, file);
      if (!hasKey("ANTHROPIC_API_KEY")) {
        return { ...base, kind: "image", status: "queued", text: "", storedPath, note: "Saved — Claude isn't connected on this deployment yet, so this photo is queued for manual review." };
      }
      const result = await extractImageProfile(file);
      if (!result) return { ...base, kind: "image", status: "failed", text: "", storedPath, note: "Couldn't make out anything useful in this photo — try a clearer, well-lit shot, or type the details instead." };
      return { ...base, kind: "image", status: "parsed", text: result.text, storedPath, imageProfile: result.profile };
    }
    if (AUDIO_EXT.test(name) || /^audio\//.test(file.mimetype || "")) {
      const storedPath = saveUploadToDisk(kind, scopeId, file);
      let transcript = null;
      try {
        transcript = await transcribeAudio(file);
      } catch (e) {
        return { ...base, kind: "audio", status: "queued", text: "", storedPath, note: `Saved — transcription failed (${e.message}), queued for manual review.` };
      }
      if (transcript === null) {
        return { ...base, kind: "audio", status: "queued", text: "", storedPath, note: "Saved — no transcription service is connected on this deployment yet, so this recording is queued for manual review." };
      }
      return { ...base, kind: "audio", status: "parsed", text: transcript, storedPath, note: transcript.trim() ? null : "Transcribed, but nothing came through — queued for review just in case." };
    }
    return { ...base, kind: "other", status: "failed", text: "", note: `Unsupported file type: ${name}` };
  } catch (e) {
    return { ...base, kind: "other", status: "failed", text: "", note: `Couldn't read ${name}: ${e.message}` };
  }
}

module.exports = {
  hasKey,
  claude,
  stripJsonFence,
  structureCorpus,
  extractImageProfile,
  transcribeAudio,
  saveUploadToDisk,
  processFile,
  MAX_STORED_TEXT_CHARS,
  UPLOADS_ROOT,
};
