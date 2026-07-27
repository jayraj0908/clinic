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

const inboundPromptPath = resolveFile("inbound-receptionist-prompt.md");
const outboundPromptPath = resolveFile("outbound-setter-prompt.md");

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
  prompts: {
    inboundPath: inboundPromptPath,
    outboundPath: outboundPromptPath,
    inbound: inboundPromptPath ? readTextSafe(inboundPromptPath) : null,
    outbound: outboundPromptPath ? readTextSafe(outboundPromptPath) : null,
  },
};
