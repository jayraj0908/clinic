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
