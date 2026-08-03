-- Multi-tenant platform schema (MULTI_TENANT=1 path only — legacy
-- single-tenant services keep using data/db.json, untouched, forever,
-- until each client is explicitly migrated per Stage 5).
--
-- Design principle: server/store.js's load()/save()/log() surface is the
-- seam every other file in this engine already depends on (hundreds of
-- call sites do `const db = load(); ...mutate db...; save();` completely
-- unaware of where the data actually lives). Rather than normalize
-- db.json's ~20 loosely-shaped arrays into 20 hand-designed relational
-- tables (a large, ongoing-migration-risk undertaking for zero real
-- benefit — nothing in this engine does relational JOINs across them,
-- every read is a plain JS .filter()/.find() over an in-memory array),
-- this schema mirrors db.json's actual shape closely: one generic
-- per-tenant "collection item" table (JSONB payload, real tenant_id
-- foreign key + indexing) plus dedicated tables only where a real
-- constraint matters (tenants.slug uniqueness, tenant_config's text
-- columns matching the file formats they replace).
--
-- Run once against a Railway Postgres addon (or locally via `psql -f`)
-- to provision the platform service's database. Idempotent — safe to
-- re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  vertical TEXT,
  brand_color TEXT,
  -- sandbox: dashboard/Teach/memory usable, no phone number, no outbound.
  -- approved: HQ has flipped this — number provisioning + dialer unlocked.
  -- suspended: HQ killswitch — same as sandbox but was previously approved.
  status TEXT NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox', 'approved', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

-- Per-tenant config that today lives as files (instance.json,
-- clinic-profile.json, messages.json, agents/<name>.md overrides) —
-- "files remain the format" per the mission's hard constraint, so each
-- row's `value` is the EXACT same text a file would have held (JSON text
-- for instance/profile/messages, raw markdown+frontmatter for an agent
-- override) — never re-parsed into a different shape at rest.
CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'instance' | 'profile' | 'messages' | 'agent:<agent-name>'
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- db.settings is a single loosely-shaped object (clinicName,
-- autoCallNewLeads, dialerPacing, integrationKeys, lastWebhookAt, ...),
-- not an array — mirrored 1:1 as one JSONB blob per tenant rather than
-- forced into the collection-item shape below.
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every db.json ARRAY (leads, calls, appointments, visits, claims,
-- agents, integrations, activity, memory, promptVersions, orders,
-- onboardings, passwordResets, magicLinks, clients, dnc, teachFiles,
-- profileEdits, leadBatches, dialerAttempts, users, ...) lives here,
-- one row per array item, `collection` naming which array it mirrors.
-- `position` preserves the array's real order (db.json's arrays are
-- unshift/push-ordered, not naturally sorted by any field) so
-- reconstructing `db.leads` etc. in server/tenantStore.js's load()
-- yields the exact same order every existing .slice(0, N)/[0] call
-- already assumes. `item_id` is the item's own .id field when present
-- (nearly everything has one) or a synthetic '_pos_<n>' key for the
-- handful of array types that don't (db.dnc is bare phone-number
-- strings, not objects).
CREATE TABLE IF NOT EXISTS tenant_collections (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position BIGINT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (tenant_id, collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_collections_lookup ON tenant_collections(tenant_id, collection, position);

-- Activity log entries (db.activity) grow unbounded in the legacy store
-- (capped at 500 client-side by store.js's log()) — same cap enforced
-- here at write time by server/tenantStore.js, not by the schema itself.

-- Stage 4 — number provisioning state, tracked separately from `tenants`
-- itself (rather than a few extra columns there) because provisioning is
-- a multi-step external pipeline (buy Twilio number → create Vapi
-- assistant → import number to Vapi) that can fail partway through —
-- this row's `status`/`error` is what lets a failed attempt be retried
-- cleanly and what an HQ confirm screen shows while it's in flight.
-- One row per tenant: a tenant only ever has one active number under
-- this pipeline (buying a second is out of scope — see the mission's
-- own "no per-tenant custom domains beyond subdomains" style scoping).
CREATE TABLE IF NOT EXISTS tenant_numbers (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number TEXT,
  twilio_sid TEXT,
  vapi_assistant_id TEXT,
  vapi_phone_number_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
