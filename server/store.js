// Simple persistent JSON store. Zero native deps — deploys anywhere.
// For multi-clinic scale, swap this module for Postgres; the API surface is tiny.
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.json");

let db = null;

function load() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } else {
    db = { users: [], leads: [], calls: [], appointments: [], visits: [], claims: [], agents: [], integrations: [], activity: [], settings: {} };
    save();
  }
  // Additive migration: fields added after a given deployment's db.json was
  // first created won't exist on it yet — default them in place rather than
  // requiring every call site to null-check. Never destructive, never
  // touches existing fields.
  let migrated = false;
  if (!Array.isArray(db.memory)) { db.memory = []; migrated = true; }
  if (!Array.isArray(db.promptVersions)) { db.promptVersions = []; migrated = true; }
  if (!Array.isArray(db.orders)) { db.orders = []; migrated = true; }
  if (!Array.isArray(db.onboardings)) { db.onboardings = []; migrated = true; }
  if (!Array.isArray(db.passwordResets)) { db.passwordResets = []; migrated = true; }
  if (!Array.isArray(db.magicLinks)) { db.magicLinks = []; migrated = true; }
  // HQ-only in practice (a plain client's db.clients just stays empty
  // forever), but additive on every instance so hqClients.js never has to
  // special-case an old db.json that predates it.
  if (!Array.isArray(db.clients)) { db.clients = []; migrated = true; }
  // Do-not-call list — phone numbers (any format; compared digit-only)
  // the owner has flagged. Checked by server/leadQueue.js before any
  // automated outbound contact; never auto-populated, owner-managed only.
  if (!Array.isArray(db.dnc)) { db.dnc = []; migrated = true; }
  // "Teach Your Brain" (server.js's /api/teach/upload) — everything ever
  // uploaded there, and the profile-shaped extractions proposed from it.
  // Facts extracted the same way land in the existing db.memory instead
  // (same approval flow the librarian already uses).
  if (!Array.isArray(db.teachFiles)) { db.teachFiles = []; migrated = true; }
  if (!Array.isArray(db.profileEdits)) { db.profileEdits = []; migrated = true; }
  // Outbound Lead Engine: bulk-imported contact batches (server/leadImport.js)
  // and the paced dialer that works them (server/dialer.js).
  if (!Array.isArray(db.leadBatches)) { db.leadBatches = []; migrated = true; }
  // Rolling log of dial-attempt timestamps, used only for the dialer's
  // rolling-hour rate limit — pruned to the last 24h on every write so it
  // never grows unbounded (server/dialer.js).
  if (!Array.isArray(db.dialerAttempts)) { db.dialerAttempts = []; migrated = true; }
  // A live instance's db.integrations was seeded before "resend" existed as
  // an entry — add it in place rather than requiring a reseed (which would
  // wipe real accumulated data) just to pick up a newly-added integration.
  if (Array.isArray(db.integrations) && !db.integrations.some((i) => i.id === "resend")) {
    db.integrations.push({ id: "resend", name: "Resend Email", role: "Booking confirmations & reminders", envKey: "RESEND_API_KEY", status: process.env.RESEND_API_KEY ? "connected" : "off" });
    migrated = true;
  }
  if (migrated) save();
  return db;
}

function save() {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH); // atomic on same filesystem
}

function log(type, message, meta = {}) {
  load().activity.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), ts: new Date().toISOString(), type, message, meta });
  db.activity = db.activity.slice(0, 500);
  save();
}

module.exports = { load, save, log, DB_PATH };
