// Instant tenancy: turns a completed onboarding draft into a live,
// logged-into tenant dashboard — no human in the loop for the dashboard
// to exist (the phone number/outbound stays human-gated, via the new
// tenant's "sandbox" status; see server/onboarding.js's completeOnboarding
// and server.js's /api/platform/tenants routes).
//
// Called from server/onboarding.js's completeOnboarding() only when
// MULTI_TENANT=1 — never touches legacy single-tenant mode at all.
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const { pool, tenantContext, hydrateTenant, load, save } = require("./tenantStore");
const { log } = require("./store");
const notify = require("./notify");
const { slugify } = require("./onboarding");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PLATFORM_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN || "sailz.org";

async function slugTaken(slug) {
  const res = await pool.query("SELECT 1 FROM tenants WHERE slug = $1", [slug]);
  return res.rowCount > 0;
}

async function uniqueTenantSlug(base) {
  let slug = slugify(base);
  let n = 2;
  while (await slugTaken(slug)) {
    slug = `${slugify(base)}-${n}`;
    n++;
  }
  return slug;
}

// Readable-on-a-phone-screen temp password — nanoid's default alphabet
// includes _ and - which are awkward to read aloud or retype from an
// email; this alphabet is unambiguous (no 0/O/1/l/I) and still high
// entropy for a MUST-be-changed-on-first-login credential.
const TEMP_PW_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
function generateTempPassword(length = 14) {
  let out = "";
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[Math.floor(Math.random() * TEMP_PW_ALPHABET.length)];
  return out;
}

function credentialsEmailHTML({ clientName, slug, email, tempPassword }) {
  const url = `https://${slug}.${PLATFORM_BASE_DOMAIN}`;
  return `
    <p>Hi ${clientName ? clientName : "there"},</p>
    <p>Your Sailz dashboard is ready: <a href="${url}">${url}</a></p>
    <p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${tempPassword}</p>
    <p>You'll be asked to set a real password the first time you sign in.</p>
    <p>Your AI phone line isn't live yet — that part still gets a quick human review before it starts taking real calls. Everything else (teaching it about your business, reviewing what it's learned) is ready right now.</p>
  `;
}

// The actual instant-tenancy pipeline. Runs entirely under the
// "_platform" tenant's own ALS context (set by tenantResolve.js for
// onboarding-path requests) up until the new tenant is created — then
// deliberately SWITCHES context into the brand-new tenant's own scope to
// write its seed data, so this reuses load()/save() exactly like every
// other piece of this engine rather than hand-writing raw SQL for the
// collections (memory, users) it needs to seed.
async function provisionTenantFromDraft(draft, clientName) {
  const { instanceJson, clinicProfileJson, messagesJson, memoryFacts, ownerEmail } = draft;
  if (!ownerEmail) throw new Error("Draft has no owner email — can't provision a tenant with nowhere to send the login.");

  const slug = await uniqueTenantSlug(instanceJson?.name || clientName);
  const tenantId = "T" + nanoid(14);

  await pool.query(
    "INSERT INTO tenants (id, slug, name, vertical, brand_color, status) VALUES ($1,$2,$3,$4,$5,'sandbox')",
    [tenantId, slug, instanceJson?.name || clientName, instanceJson?.vertical || null, instanceJson?.brandColor || null]
  );

  // Same TEXT format the file-based path would have written to
  // instance.json/clinic-profile.json/messages.json — stored as DB rows
  // instead, per the mission's own hard constraint ("files remain the
  // format"). agents/<name>.md overrides aren't produced by the wizard
  // today (that's a Cursor-assisted build step per clients/
  // INSTANCE-BUILD-PROMPT.md) — nothing to seed here for those yet.
  await pool.query(
    `INSERT INTO tenant_config (tenant_id, key, value) VALUES ($1,'instance',$2),($1,'profile',$3),($1,'messages',$4)`,
    [tenantId, JSON.stringify(instanceJson, null, 2), JSON.stringify(clinicProfileJson, null, 2), JSON.stringify(messagesJson, null, 2)]
  );

  const ownerId = "u" + nanoid(12);
  const tempPassword = generateTempPassword();
  const ownerUser = {
    id: ownerId,
    email: ownerEmail,
    passHash: bcrypt.hashSync(tempPassword, 10),
    name: ownerEmail.split("@")[0],
    role: "owner",
    mustChangePassword: true,
  };

  // Switch into the NEW tenant's own context to seed its starting data —
  // reuses load()/save() exactly like every real request against this
  // tenant will, rather than hand-rolling separate INSERT statements for
  // memory/users (which would have to independently reimplement
  // tenantStore's flush/position bookkeeping).
  await hydrateTenant(tenantId);
  await tenantContext.run({ tenantId }, async () => {
    const db = load();
    db.users.push(ownerUser);
    for (const f of memoryFacts || []) {
      db.memory.push({
        id: "M" + Date.now() + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        type: f.type || "policy_correction",
        fact: f.fact,
        source: f.source || "onboarding",
        status: "proposed",
      });
    }
    db.settings = db.settings || {};
    db.settings.clinicName = instanceJson?.name || clientName;
    save();
  });
  // save() flushes asynchronously in the background (see tenantStore.js) —
  // wait for it explicitly here so the credentials email and bootstrap
  // token are never sent/issued before the seed data is actually durable.
  await flushAndWait(tenantId);

  notify.sendEmail(ownerEmail, `Your Sailz dashboard is ready`, credentialsEmailHTML({ clientName: instanceJson?.name || clientName, slug, email: ownerEmail, tempPassword }))
    .catch((e) => log("notify", `Tenant credentials email error for ${slug}: ${e.message}`));

  const bootstrapToken = jwt.sign(
    { purpose: "bootstrap", id: ownerId, role: "owner", tenantId },
    JWT_SECRET,
    { expiresIn: "10m" }
  );

  log("system", `Provisioned tenant "${slug}" (${tenantId}) for ${instanceJson?.name || clientName} — sandbox status`);
  return { tenantId, slug, bootstrapToken, redirectUrl: `https://${slug}.${PLATFORM_BASE_DOMAIN}/?bootstrap=${bootstrapToken}` };
}

// tenantStore's save() is deliberately fire-and-forget for ordinary
// request handling (matching legacy store.js's own reliability posture)
// — but provisioning is the one place that genuinely needs to know the
// seed data landed before emailing credentials/issuing a session for it.
// tenantStore exports flush() specifically for cases like this (also
// used by the Stage 5 migration script) — call it directly and await it,
// which does exactly what the pending background flush was already
// about to do, just synchronously from this caller's point of view.
async function flushAndWait(tenantId) {
  const { flush } = require("./tenantStore");
  const db = tenantContext.run({ tenantId }, () => load());
  await flush(tenantId, { db });
}

module.exports = { provisionTenantFromDraft, uniqueTenantSlug, generateTempPassword };
