// Host-header tenant resolution — the front door of MULTI_TENANT=1 mode.
// Runs before every other route. Resolves <slug> from the request's Host
// header, looks it up against the tenants table (NEVER trusts a
// client-supplied id from a URL param, query string, or body — that's
// the whole isolation guarantee), hydrates that tenant's data into
// server/tenantStore.js's in-memory cache, and threads the tenantId
// through AsyncLocalStorage for the rest of the request.
//
// A host that doesn't map to any real tenant (the bare apex domain,
// www, or a subdomain that just doesn't exist) gets a generic marketing
// placeholder — never a 404 that would confirm/deny whether a specific
// slug exists. Cross-tenant ACCESS attempts (an authenticated session
// for tenant A hitting tenant B's resolved host) are a separate concern,
// enforced in the auth layer by checking the JWT's own tenantId claim
// against req.tenant.id — that's where the 404 requirement in the
// mission's isolation guarantee actually lives, not here.
const { tenantContext, hydrateTenant, pool } = require("./tenantStore");

const RESERVED_SUBDOMAINS = new Set(["www", "hq", "admin", "api"]);

function subdomainFromHost(host) {
  if (!host) return null;
  const bare = String(host).split(":")[0].toLowerCase();
  const parts = bare.split(".");
  if (parts.length < 3) return null; // apex domain or bare "localhost" — no subdomain to resolve
  return parts[0];
}

// Short TTL cache on the tenant ROW only (id/slug/name/vertical/
// brandColor/status) — not the tenant's full data, which lives in
// tenantStore's own hydrate cache. Avoids a tenants-table round-trip on
// every single request while still picking up a status flip (e.g. HQ
// approving a sandbox tenant) within seconds, not requiring a restart.
const rowCache = new Map(); // slug -> { row, cachedAt }
const ROW_CACHE_TTL_MS = 15_000;

async function lookupTenantBySlug(slug) {
  const cached = rowCache.get(slug);
  if (cached && Date.now() - cached.cachedAt < ROW_CACHE_TTL_MS) return cached.row;
  const res = await pool.query(
    "SELECT id, slug, name, vertical, brand_color, status FROM tenants WHERE slug = $1",
    [slug]
  );
  const row = res.rows[0] || null;
  rowCache.set(slug, { row, cachedAt: Date.now() });
  return row;
}

// Invalidate immediately after any write to a tenant's own row (status
// flip, rename) — server.js's HQ-approval route calls this so the change
// is visible on the very next request, not after the TTL expires.
function invalidateTenantRowCache(slug) {
  rowCache.delete(slug);
}

function sendMarketingPlaceholder(res) {
  res.status(200).type("html").send(
    "<!doctype html><html><head><title>Sailz</title>" +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="font-family:-apple-system,sans-serif;text-align:center;padding:120px 20px;background:#0a0a0d;color:#e8e6e0">' +
    '<h1 style="font-weight:600;letter-spacing:.05em">SAILZ</h1>' +
    "<p>Your AI front desk — answers every call, books the thing, confirms it.</p>" +
    "</body></html>"
  );
}

function tenantResolveMiddleware() {
  return async (req, res, next) => {
    const slug = subdomainFromHost(req.headers.host);
    if (!slug || RESERVED_SUBDOMAINS.has(slug)) {
      return sendMarketingPlaceholder(res);
    }
    let row;
    try {
      row = await lookupTenantBySlug(slug);
    } catch (e) {
      console.error(`[tenantResolve] tenant lookup failed for "${slug}": ${e.message}`);
      return res.status(503).json({ error: "Temporarily unavailable." });
    }
    if (!row) {
      return sendMarketingPlaceholder(res);
    }
    req.tenant = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      vertical: row.vertical,
      brandColor: row.brand_color,
      status: row.status,
    };
    try {
      await hydrateTenant(row.id);
    } catch (e) {
      console.error(`[tenantResolve] hydrate failed for tenant ${row.id}: ${e.message}`);
      return res.status(503).json({ error: "Temporarily unavailable." });
    }
    tenantContext.run({ tenantId: row.id }, () => next());
  };
}

module.exports = { tenantResolveMiddleware, subdomainFromHost, invalidateTenantRowCache };
