#!/usr/bin/env node
// Stage 5 — migrates one legacy single-tenant client (a file-based
// instance + its db.json) into a row in the multi-tenant platform's
// Postgres database. Read-only against the source: the legacy
// deployment (Shine, The Burg, or any future client on its own
// dedicated service) is never modified or even written to — this
// script only ever reads instances/<slug>/*.json and a db.json, then
// writes into the PLATFORM service's own Postgres (via DATABASE_URL in
// this process's env, same as tenantStore.js/tenantProvision.js use).
//
// This is deliberately NOT wired into any live Railway deployment's
// boot path — it's a one-shot, manually-run operator tool, run against
// a COPY of a client's db.json (pulled down separately, e.g. from a
// Railway volume snapshot), never against a live production file, so a
// mistake here can never touch the client's real, currently-serving
// deployment.
//
// Usage:
//   node scripts/migrate-legacy-tenant.mjs <instance-slug> <db-json-path> [--dry-run] [--status=approved|sandbox] [--force]
// Example (dry run first, always):
//   node scripts/migrate-legacy-tenant.mjs shine-dental /path/to/shine-db-copy.json --dry-run
//   node scripts/migrate-legacy-tenant.mjs shine-dental /path/to/shine-db-copy.json --status=approved
//
// --status defaults to 'approved', NOT the instant-provisioning
// pipeline's 'sandbox' default (server/tenantProvision.js) — a
// migration is for a client who is ALREADY live with a working phone
// number; landing them in sandbox would silently re-lock outbound
// features they already have in production, which is a regression, not
// a safety win. Override with --status=sandbox only if migrating a
// client Sailz deliberately wants to re-review.
//
// --force allows re-running against a slug that already has a tenant
// row (skips the uniqueness refusal) — useful for iterating on a test
// migration; never use this against a slug that's already live-cutover
// on the platform.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { COLLECTIONS, pool } from "../server/tenantStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const dryRun = flags.includes("--dry-run");
const force = flags.includes("--force");
const statusFlag = flags.find((f) => f.startsWith("--status="))?.split("=")[1] || "approved";

const [instanceSlug, dbJsonPath] = args;
if (!instanceSlug || !dbJsonPath) {
  console.error("Usage: node scripts/migrate-legacy-tenant.mjs <instance-slug> <db-json-path> [--dry-run] [--status=approved|sandbox] [--force]");
  process.exit(1);
}
if (!["approved", "sandbox"].includes(statusFlag)) {
  console.error(`--status must be 'approved' or 'sandbox', got '${statusFlag}'`);
  process.exit(1);
}

function readJSONText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

async function main() {
  const instanceDir = path.join(REPO_ROOT, "instances", instanceSlug);
  if (!fs.existsSync(instanceDir)) {
    console.error(`No instances/${instanceSlug}/ directory found.`);
    process.exit(1);
  }
  if (!fs.existsSync(dbJsonPath)) {
    console.error(`db.json copy not found at ${dbJsonPath}`);
    process.exit(1);
  }

  const instanceText = readJSONText(path.join(instanceDir, "instance.json"));
  const profileText = readJSONText(path.join(instanceDir, "clinic-profile.json"));
  const messagesText = readJSONText(path.join(instanceDir, "messages.json"));
  const instanceJson = instanceText ? JSON.parse(instanceText) : {};
  const db = JSON.parse(fs.readFileSync(dbJsonPath, "utf8"));

  const slug = instanceJson.id || instanceSlug;
  const name = instanceJson.name || instanceSlug;
  const vertical = instanceJson.vertical || null;
  const brandColor = instanceJson.brandColor || null;

  const collectionCounts = {};
  for (const c of COLLECTIONS) {
    if (Array.isArray(db[c])) collectionCounts[c] = db[c].length;
  }
  const settings = db.settings || {};

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Migrating "${instanceSlug}" → tenant slug "${slug}" (status: ${statusFlag})`);
  console.log(`  name: ${name} · vertical: ${vertical || "—"}`);
  console.log(`  tenant_config: instance.json (${instanceText ? instanceText.length : 0}b) · clinic-profile.json (${profileText ? profileText.length : 0}b) · messages.json (${messagesText ? messagesText.length : 0}b)`);
  console.log(`  tenant_settings: ${Object.keys(settings).length} top-level keys`);
  console.log(`  tenant_collections:`);
  for (const [c, n] of Object.entries(collectionCounts)) {
    if (n > 0) console.log(`    ${c}: ${n} row(s)`);
  }
  const unknownArrays = Object.keys(db).filter((k) => Array.isArray(db[k]) && !COLLECTIONS.includes(k));
  if (unknownArrays.length) {
    console.log(`  ⚠ db.json has array(s) not in tenantStore.js's COLLECTIONS list (will be SKIPPED, not migrated): ${unknownArrays.join(", ")}`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing written. Re-run without --dry-run to actually migrate.");
    await pool.end();
    return;
  }

  const existing = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (existing.rows[0] && !force) {
    console.error(`\nA tenant with slug "${slug}" already exists (id ${existing.rows[0].id}). Re-run with --force to proceed anyway, or pick a different slug.`);
    await pool.end();
    process.exit(1);
  }

  const tenantId = existing.rows[0]?.id || "T" + nanoid(14);
  await pool.query(
    `INSERT INTO tenants (id, slug, name, vertical, brand_color, status) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, vertical = EXCLUDED.vertical, brand_color = EXCLUDED.brand_color`,
    [tenantId, slug, name, vertical, brandColor, statusFlag]
  );

  await pool.query("DELETE FROM tenant_config WHERE tenant_id = $1", [tenantId]);
  const configRows = [
    instanceText && ["instance", instanceText],
    profileText && ["profile", profileText],
    messagesText && ["messages", messagesText],
  ].filter(Boolean);
  for (const [key, value] of configRows) {
    await pool.query("INSERT INTO tenant_config (tenant_id, key, value) VALUES ($1,$2,$3)", [tenantId, key, value]);
  }

  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, data) VALUES ($1,$2)
     ON CONFLICT (tenant_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [tenantId, JSON.stringify(settings)]
  );

  await pool.query("DELETE FROM tenant_collections WHERE tenant_id = $1", [tenantId]);
  let totalRows = 0;
  for (const collection of COLLECTIONS) {
    const arr = Array.isArray(db[collection]) ? db[collection] : [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemId = item && typeof item === "object" && item.id ? String(item.id) : `_pos_${i}`;
      await pool.query(
        "INSERT INTO tenant_collections (tenant_id, collection, item_id, position, data) VALUES ($1,$2,$3,$4,$5)",
        [tenantId, collection, itemId, i, JSON.stringify(item)]
      );
      totalRows++;
    }
  }

  console.log(`\nMigrated tenant "${slug}" (${tenantId}) — ${configRows.length} config file(s), ${totalRows} collection row(s).`);
  console.log(`Next: hydrate/verify it (server running with MULTI_TENANT=1, Host: ${slug}.<platform-domain>), then see docs/CUTOVER.md before flipping real DNS.`);
  await pool.end();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
