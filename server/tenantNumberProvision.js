// Stage 4 — number provisioning assist. One click on HQ's confirm screen
// buys a real Twilio number, creates a Vapi assistant from the tenant's
// own onboarding-collected profile, imports the number into Vapi
// pointed at that assistant, and wires its webhook at the tenant's own
// subdomain (so tenantResolve.js's Host-based resolution picks it up
// exactly like every other request against that tenant).
//
// Feature-flagged: NUMBER_PROVISIONING=1. Off by default everywhere,
// including the platform service itself, until Jay is ready to spend
// real money against the platform's own Twilio account per approved
// tenant — this module does nothing at all with the flag unset.
//
// Gated on tenant.status === 'approved' (server.js's requirePlatformKey
// route enforces this) — a SEPARATE, later action from approving the
// tenant itself: approval unlocks the *option* to provision a number,
// it doesn't trigger a purchase by itself. HQ's confirm screen is the
// actual "yes, spend the money" moment.
//
// Rollback: each step only runs after the previous one's result is
// durably recorded, and any failure tears down everything already
// created before returning the error — a half-provisioned tenant never
// silently sits there costing money with no working phone line.
const { pool } = require("./tenantStore");
const { renderMenu, renderHours, renderPolicies, toolsForVertical, ANALYSIS_SCHEMA, DEFAULT_VOICE, DEFAULT_MODEL } = require("./vapiAssistant");
// Platform-admin routes deliberately run with NO tenant in AsyncLocalStorage
// (tenantResolve.js routes them around ALS entirely — they're cross-tenant
// by nature). store.js's log() is tenant-scoped and throws without that
// context, so this module logs straight to console, same as
// tenantResolve.js's own error logging does for the same reason.
const log = (level, msg) => (level === "error" ? console.error(msg) : console.log(msg));

const NUMBER_PROVISIONING = process.env.NUMBER_PROVISIONING === "1";
const PLATFORM_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN || "sailz.org";

// Deliberately distinct from notify.js's TWILIO_SID/TWILIO_AUTH (which
// may be a scoped API Key pair, fine for sending SMS) — buying/releasing
// numbers and handing credentials to Vapi so IT can manage the number
// needs the real account Auth Token, not a scoped key.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_ACCOUNT_AUTH_TOKEN = process.env.TWILIO_ACCOUNT_AUTH_TOKEN;
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;

function hasTwilio() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_ACCOUNT_AUTH_TOKEN);
}
function twilioAuthHeader() {
  return "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_ACCOUNT_AUTH_TOKEN}`).toString("base64");
}

async function twilioRequest(pathSuffix, { method = "GET", form } = {}) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}${pathSuffix}`, {
    method,
    headers: {
      authorization: twilioAuthHeader(),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio ${method} ${pathSuffix} failed (${res.status})`);
  return data;
}

async function vapiRequest(pathSuffix, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.vapi.ai${pathSuffix}`, {
    method,
    headers: {
      authorization: `Bearer ${VAPI_API_KEY}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Vapi ${method} ${pathSuffix} failed (${res.status})`);
  return data;
}

// Real numbers, real monthly cost (~$1/mo, US local) — this is the list
// the confirm screen's picker renders; nothing is bought until
// provisionNumberForTenant is actually called.
async function searchAvailableNumbers(areaCode) {
  if (!hasTwilio()) throw new Error("Twilio is not configured on this platform service.");
  const qs = new URLSearchParams({ VoiceEnabled: "true", ...(areaCode ? { AreaCode: areaCode } : {}) });
  const data = await twilioRequest(`/AvailablePhoneNumbers/US/Local.json?${qs}`);
  return (data.available_phone_numbers || []).slice(0, 10).map((n) => ({
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    locality: n.locality,
    region: n.region,
  }));
}

async function buyTwilioNumber(phoneNumber) {
  const data = await twilioRequest("/IncomingPhoneNumbers.json", { method: "POST", form: { PhoneNumber: phoneNumber } });
  return { sid: data.sid, phoneNumber: data.phone_number };
}

async function releaseTwilioNumber(sid) {
  try {
    await twilioRequest(`/IncomingPhoneNumbers/${sid}.json`, { method: "DELETE" });
  } catch (e) {
    log("error", `Rollback: failed to release Twilio number ${sid}: ${e.message} — release it manually in the Twilio console.`);
  }
}

// Builds a tenant's system prompt straight from its tenant_config rows
// (the same "instance"/"profile" JSON text server/tenantProvision.js
// wrote at onboarding time) — the tenant-mode equivalent of
// vapiAssistant.js's composeSystemPromptUncached(), which reads from
// files/legacy load() and can't be reused directly here.
async function composeTenantSystemPrompt(tenantId) {
  const res = await pool.query("SELECT key, value FROM tenant_config WHERE tenant_id = $1 AND key IN ('instance','profile')", [tenantId]);
  const rows = Object.fromEntries(res.rows.map((r) => [r.key, r.value]));
  const instanceJson = rows.instance ? JSON.parse(rows.instance) : {};
  const profile = rows.profile ? JSON.parse(rows.profile) : {};
  const sections = [renderMenu(profile), renderHours(profile), renderPolicies(profile)].filter(Boolean);
  const name = instanceJson.name || "us";
  const header = `You are the AI receptionist for ${name}. Answer calls warmly, book the thing, confirm it. Never guess — if you don't know something from the sections below, say so honestly and offer to have a human follow up.`;
  return { prompt: [header, ...sections].join("\n\n"), instanceJson };
}

async function createVapiAssistant(tenantId, slug) {
  const { prompt, instanceJson } = await composeTenantSystemPrompt(tenantId);
  const vapiCfg = instanceJson.vapi || {};
  const body = {
    name: `${instanceJson.name || slug} — Sailz Receptionist`,
    firstMessage: vapiCfg.firstMessage || `Thanks for calling ${instanceJson.name || "us"} — how can I help?`,
    model: {
      ...(vapiCfg.model || DEFAULT_MODEL),
      messages: [{ role: "system", content: prompt }],
      tools: toolsForVertical(instanceJson.vertical),
    },
    voice: vapiCfg.voice || DEFAULT_VOICE,
    serverUrl: `https://${slug}.${PLATFORM_BASE_DOMAIN}/webhooks/vapi`,
    serverUrlSecret: VAPI_SERVER_SECRET || undefined,
    analysisPlan: { structuredDataSchema: ANALYSIS_SCHEMA },
  };
  const data = await vapiRequest("/assistant", { method: "POST", body });
  return data.id;
}

async function deleteVapiAssistant(id) {
  try {
    await vapiRequest(`/assistant/${id}`, { method: "DELETE" });
  } catch (e) {
    log("error", `Rollback: failed to delete Vapi assistant ${id}: ${e.message} — remove it manually in the Vapi dashboard.`);
  }
}

async function importNumberToVapi({ phoneNumber, assistantId }) {
  const data = await vapiRequest("/phone-number", {
    method: "POST",
    body: {
      provider: "twilio",
      number: phoneNumber,
      twilioAccountSid: TWILIO_ACCOUNT_SID,
      twilioAuthToken: TWILIO_ACCOUNT_AUTH_TOKEN,
      assistantId,
    },
  });
  return data.id;
}

async function upsertNumberRow(tenantId, fields) {
  await pool.query(
    `INSERT INTO tenant_numbers (tenant_id, phone_number, twilio_sid, vapi_assistant_id, vapi_phone_number_id, status, error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       phone_number = EXCLUDED.phone_number, twilio_sid = EXCLUDED.twilio_sid,
       vapi_assistant_id = EXCLUDED.vapi_assistant_id, vapi_phone_number_id = EXCLUDED.vapi_phone_number_id,
       status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()`,
    [tenantId, fields.phoneNumber || null, fields.twilioSid || null, fields.vapiAssistantId || null, fields.vapiPhoneNumberId || null, fields.status, fields.error || null]
  );
}

// The orchestrator. `phoneNumber` must be one of the numbers the confirm
// screen showed the operator (from searchAvailableNumbers) — this
// function does not pick one on its own, so what gets bought is always
// exactly what was shown and confirmed.
async function provisionNumberForTenant(tenantId, slug, phoneNumber) {
  if (!NUMBER_PROVISIONING) throw new Error("Number provisioning is not enabled on this platform service.");
  if (!hasTwilio()) throw new Error("Twilio is not configured on this platform service.");
  if (!VAPI_API_KEY) throw new Error("Vapi is not configured on this platform service.");

  let twilioSid = null;
  let assistantId = null;
  let vapiPhoneNumberId = null;
  try {
    const bought = await buyTwilioNumber(phoneNumber);
    twilioSid = bought.sid;
    await upsertNumberRow(tenantId, { phoneNumber: bought.phoneNumber, twilioSid, status: "pending" });

    assistantId = await createVapiAssistant(tenantId, slug);
    await upsertNumberRow(tenantId, { phoneNumber: bought.phoneNumber, twilioSid, vapiAssistantId: assistantId, status: "pending" });

    vapiPhoneNumberId = await importNumberToVapi({ phoneNumber: bought.phoneNumber, assistantId });
    await upsertNumberRow(tenantId, {
      phoneNumber: bought.phoneNumber,
      twilioSid,
      vapiAssistantId: assistantId,
      vapiPhoneNumberId,
      status: "active",
    });

    log("system", `Number provisioned for tenant ${slug}: ${bought.phoneNumber}`);
    return { phoneNumber: bought.phoneNumber, status: "active" };
  } catch (e) {
    // Tear down whatever already succeeded, in reverse order, before
    // surfacing the error — never leave a half-built, silently-billing
    // number behind.
    if (assistantId) await deleteVapiAssistant(assistantId);
    if (twilioSid) await releaseTwilioNumber(twilioSid);
    await upsertNumberRow(tenantId, { status: "failed", error: e.message });
    log("error", `Number provisioning failed for tenant ${slug}: ${e.message}`);
    throw e;
  }
}

module.exports = {
  NUMBER_PROVISIONING,
  searchAvailableNumbers,
  provisionNumberForTenant,
};
