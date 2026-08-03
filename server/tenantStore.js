// Postgres-backed store for MULTI_TENANT=1 mode — implements the exact
// load()/save()/log() surface server/store.js exports, so every existing
// call site across this engine (hundreds of them, in server.js, agents.js,
// dialer.js, leadImport.js, catalog.js, ...) works completely unchanged in
// either mode. server/store.js itself delegates here when MULTI_TENANT=1
// is set; otherwise it keeps its original file-based behavior, untouched.
//
// THE CORE PROBLEM THIS SOLVES: load()/save()/log() are synchronous
// everywhere they're called (`const db = load(); ...mutate...; save();`,
// inside otherwise-sync code and inside async route handlers alike) — but
// Postgres queries are inherently async. Rewriting every call site to
// `await load()` would touch hundreds of places across this engine, which
// is exactly the "in-place rewrite" the multi-tenant mission explicitly
// rules out ("Multi-tenant mode is a parallel path... not an in-place
// rewrite").
//
// The fix: an in-memory per-tenant cache, populated by an AWAITED
// Postgres read in server/tenantResolve.js's middleware BEFORE the route
// handler ever runs (hydrateTenant, below). By the time a route handler
// calls the synchronous load(), that tenant's full db object is already
// in memory — load() just returns it, exactly like legacy store.js's own
// module-level `db` cache. save() marks the tenant dirty and fires an
// async Postgres flush in the background (fire-and-forget, logged loudly
// on failure, serialized per tenant so two rapid saves can't race each
// other's writes) — the same "assume the write succeeds" reliability
// posture legacy store.js's fs.writeFileSync-and-hope already has today,
// just over the network instead of the filesystem.
//
// Tenant identity flows through AsyncLocalStorage (node:async_hooks), set
// once per request by tenantResolve.js, so load()/save()/log() keep their
// exact zero-argument signatures in both modes — nothing downstream of
// store.js needs to know or care which mode it's running in.
const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool } = require("pg");

const tenantContext = new AsyncLocalStorage();

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway's Postgres addon (and most managed PG) terminates TLS
      // with a cert chain `pg` won't validate by default under a plain
      // `ssl: true` — the standard escape hatch. Set PGSSL=0 for a local
      // Postgres with no TLS at all (this repo's own dev/test setup).
      ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false },
    })
  : null;

// Every db.json array field legacy store.js's own load() migration block
// knows about — kept as a flat list here (not derived from that file)
// since the two are allowed to diverge slightly in cadence; this list is
// the pg store's OWN contract for which collections round-trip through
// tenant_collections. Add a new one here AND to legacy store.js's
// migration block when a new db.json array field is introduced.
const COLLECTIONS = [
  "users", "leads", "calls", "appointments", "visits", "claims", "agents",
  "integrations", "activity", "memory", "promptVersions", "orders",
  "onboardings", "passwordResets", "magicLinks", "clients", "dnc",
  "teachFiles", "profileEdits", "leadBatches", "dialerAttempts",
];

// tenantId -> { db, needsFlush, flushing }
const caches = new Map();

function currentTenantId() {
  const store = tenantContext.getStore();
  if (!store?.tenantId) {
    // Fail closed — a route running outside tenant context is a bug that
    // must never silently fall back to some default tenant's data. This
    // is the single most important line in this file for isolation.
    throw new Error("tenantStore: no tenant in AsyncLocalStorage context — every MULTI_TENANT request must go through tenantResolve middleware first.");
  }
  return store.tenantId;
}

function emptyDb() {
  const db = { settings: {} };
  for (const c of COLLECTIONS) db[c] = [];
  return db;
}

// Populates the in-memory cache for a tenant from Postgres. Called by
// server/tenantResolve.js's middleware (awaited, before next()) — never
// by load()/save() themselves, which must stay synchronous. Idempotent:
// a second call for an already-cached tenant is a no-op (returns the live
// object, not a stale snapshot) so the middleware can call this on every
// request cheaply once warm.
async function hydrateTenant(tenantId) {
  if (caches.has(tenantId)) return caches.get(tenantId).db;
  if (!pool) throw new Error("tenantStore: DATABASE_URL is not set — MULTI_TENANT=1 requires it.");

  const db = emptyDb();
  const settingsRes = await pool.query("SELECT data FROM tenant_settings WHERE tenant_id = $1", [tenantId]);
  if (settingsRes.rows[0]) db.settings = settingsRes.rows[0].data;

  const itemsRes = await pool.query(
    "SELECT collection, item_id, position, data FROM tenant_collections WHERE tenant_id = $1 ORDER BY collection, position ASC",
    [tenantId]
  );
  for (const row of itemsRes.rows) {
    if (!Array.isArray(db[row.collection])) db[row.collection] = [];
    db[row.collection].push(row.data);
  }

  caches.set(tenantId, { db, needsFlush: false, flushing: null });
  return db;
}

function isHydrated(tenantId) {
  return caches.has(tenantId);
}

// Drops a tenant's in-memory cache (e.g. after a direct DB write outside
// the normal load/save path, or for tests that want a clean re-hydrate).
// Never called mid-request in production — only ever between requests.
function evictTenant(tenantId) {
  caches.delete(tenantId);
}

function load() {
  const tenantId = currentTenantId();
  const entry = caches.get(tenantId);
  if (!entry) {
    throw new Error(`tenantStore: tenant ${tenantId} not hydrated — tenantResolve middleware must await hydrateTenant() before the route handler runs.`);
  }
  return entry.db;
}

function save() {
  const tenantId = currentTenantId();
  const entry = caches.get(tenantId);
  if (!entry) return;
  entry.needsFlush = true;
  scheduleFlush(tenantId, entry);
}

// Serializes flushes per tenant — without this, two save() calls in quick
// succession (two concurrent requests mutating the same tenant) could
// interleave their DELETE/INSERT statements against tenant_collections
// and corrupt data, since each awaited query yields the event loop.
// Coalesces rapid saves too: if three saves happen while one flush is in
// flight, only one more flush runs after it, and that flush reads
// entry.db fresh at the time it actually executes — never a stale
// snapshot from when save() was first called.
function scheduleFlush(tenantId, entry) {
  if (entry.flushing) return;
  entry.flushing = (async () => {
    while (entry.needsFlush) {
      entry.needsFlush = false;
      try {
        await flush(tenantId, entry);
      } catch (e) {
        console.error(`[tenantStore] flush failed for tenant ${tenantId}: ${e.message}`);
      }
    }
    entry.flushing = null;
  })();
}

// Full delete-and-reinsert per collection, same as legacy store.js's own
// save() rewriting the entire db.json file on every call regardless of
// how small the change was — parity with the existing reliability/
// performance posture, not a regression. A batched multi-row INSERT
// (or diffing to only touch changed rows) would be the natural next
// optimization if per-save latency ever matters at real tenant scale;
// not attempted here since correctness came first for this stage.
async function flush(tenantId, entry) {
  const { db } = entry;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id) DO UPDATE SET data = $2, updated_at = now()`,
      [tenantId, JSON.stringify(db.settings || {})]
    );
    for (const collection of COLLECTIONS) {
      const items = Array.isArray(db[collection]) ? db[collection] : [];
      await client.query("DELETE FROM tenant_collections WHERE tenant_id = $1 AND collection = $2", [tenantId, collection]);
      let position = 0;
      for (const item of items) {
        const itemId = item && item.id != null ? String(item.id) : `_pos_${position}`;
        await client.query(
          "INSERT INTO tenant_collections (tenant_id, collection, item_id, position, data) VALUES ($1, $2, $3, $4, $5)",
          [tenantId, collection, itemId, position, JSON.stringify(item)]
        );
        position++;
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function log(type, message, meta = {}) {
  const db = load();
  db.activity.unshift({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), ts: new Date().toISOString(), type, message, meta });
  db.activity = db.activity.slice(0, 500);
  save();
}

module.exports = {
  load,
  save,
  log,
  hydrateTenant,
  isHydrated,
  evictTenant,
  tenantContext,
  pool,
  COLLECTIONS,
  // Exposed for tests / the migration script (Stage 5) — never used by
  // ordinary request handling, which always goes through load()/save().
  flush,
};
