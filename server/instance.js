// Instance loader — the one place that resolves "which client is this
// deployment for". Everything client-specific (clinic facts, Vapi prompt
// reference docs, branding) lives in instances/<id>/, never in engine code.
//
// Resolution order per file: instances/${INSTANCE}/<file> → legacy
// server/knowledge-base/<file> (pre-refactor location) → a hardcoded
// minimal default. This means a fresh deploy — or one where INSTANCE points
// at a folder that isn't there yet — still boots and serves a sane default
// instead of 500ing before env vars/config are in place.
const fs = require("fs");
const path = require("path");

const INSTANCE = process.env.INSTANCE || "shine-dental";
const instanceDir = path.join(__dirname, "..", "instances", INSTANCE);
const legacyDir = path.join(__dirname, "knowledge-base");

const DEFAULT_INSTANCE_META = {
  id: INSTANCE,
  name: process.env.CLINIC_NAME || "Your Clinic",
  vertical: null,
  brandColor: "#c9a066",
  timezone: process.env.CLINIC_TIMEZONE || "America/New_York",
};
const DEFAULT_PROFILE = {
  name: DEFAULT_INSTANCE_META.name,
  timezone: DEFAULT_INSTANCE_META.timezone,
  hours: [],
  services: [],
  insuranceAccepted: [],
  selfPay: "",
  policies: [],
};
// Outbound message templates — never hardcode clinic wording in code.
// Placeholders: {clinic} {service} {date} {time} {number} {patient}
const DEFAULT_MESSAGES = {
  bookingConfirmationSMS: "You're booked at {clinic} — {service}, {date} {time}. Reply here or call {number} to reschedule.",
  bookingConfirmationEmailSubject: "Your appointment at {clinic} is confirmed",
  bookingConfirmationEmailHTML: "<p>Hi {patient},</p><p>You're booked at <strong>{clinic}</strong> — {service}, {date} {time}.</p><p>Reply to this email or call {number} to reschedule.</p>",
  reminderSMS: "Reminder: you have an appointment at {clinic} tomorrow — {service}, {date} {time}. Call {number} if you need to reschedule.",
  // Restaurant vertical (orders) — generic engine default; a real
  // restaurant instance overrides with its own wording (see
  // instances/the-burg/messages.json). Never used by a non-order instance.
  orderConfirmationSMS: "Thanks {patient}! Your order at {clinic} is confirmed — {orderItems}. Total: {total}. Ready around {pickupTime}. Call {number} with any changes.",
};

function readJSONSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function resolveFile(filename) {
  const primary = path.join(instanceDir, filename);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(legacyDir, filename);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

const instanceMetaPath = resolveFile("instance.json");
const instance = instanceMetaPath ? readJSONSafe(instanceMetaPath, DEFAULT_INSTANCE_META) : DEFAULT_INSTANCE_META;

const profilePath = resolveFile("clinic-profile.json");
const profile = profilePath ? readJSONSafe(profilePath, DEFAULT_PROFILE) : DEFAULT_PROFILE;

// Replay any Teach-approved profile edits (server.js's /api/profile-edits/
// :id/approve — new service, price/hours change, etc.) on top of the static
// file. This is a DB-backed overlay, not a file rewrite: an approval
// mutates `profile` in place immediately (live on the very next call, no
// redeploy — see server/profileEdits.js), and this replay is what makes
// that survive an actual process restart, since `profile` above is
// otherwise re-read fresh from the static file on every boot.
try {
  const { load } = require("./store");
  const { applyProfileEdit } = require("./profileEdits");
  const db = load();
  (db.profileEdits || [])
    .filter((e) => e.status === "approved")
    .forEach((e) => { try { applyProfileEdit(profile, e.diff); } catch { /* skip a bad overlay entry, don't fail boot */ } });
} catch { /* db not ready yet on a truly fresh boot — profile stays file-only until the first edit is approved */ }

const inboundPromptPath = resolveFile("inbound-receptionist-prompt.md");
const outboundPromptPath = resolveFile("outbound-setter-prompt.md");

const messagesPath = resolveFile("messages.json");
const messages = messagesPath ? { ...DEFAULT_MESSAGES, ...readJSONSafe(messagesPath, {}) } : DEFAULT_MESSAGES;

// Instances may also override/extend agent definitions (Stage 2) —
// exposing the resolved directory lets brain.js check
// instances/<id>/agents/*.md without duplicating resolution logic here.
const instanceAgentsDir = path.join(instanceDir, "agents");

module.exports = {
  INSTANCE,
  instanceDir,
  instanceAgentsDir,
  instance,
  profile,
  messages,
  prompts: {
    inboundPath: inboundPromptPath,
    outboundPath: outboundPromptPath,
    inbound: inboundPromptPath ? readTextSafe(inboundPromptPath) : null,
    outbound: outboundPromptPath ? readTextSafe(outboundPromptPath) : null,
  },
};
