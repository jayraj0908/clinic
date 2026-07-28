// Small security-focused helpers, kept in one place so they're easy to find
// and audit together rather than scattered across route handlers.
const crypto = require("crypto");

// Masks a phone number to just its last 4 digits for activity-log entries —
// the log is readable by any authenticated user (not just the owner), so it
// shouldn't permanently retain the full number every time a call/lead/SMS
// touches it. Non-digit formatting is stripped first so "(555) 123-4567",
// "+15551234567", and "555-123-4567" all mask the same way.
function maskPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return "***-" + digits.slice(-4);
}

// Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw request
// body, keyed with the app secret, hex-encoded and prefixed "sha256=".
// Requires express.json()'s `verify` hook to have captured req.rawBody,
// since re-serializing the parsed JSON can produce different bytes than
// what Meta actually signed (key order, whitespace) and would falsely fail.
//
// Only enforced when META_APP_SECRET is set — matches the same
// optional-if-configured pattern already used for VAPI_SERVER_SECRET and
// GOOGLE_ADS_WEBHOOK_KEY, so an instance that hasn't wired the secret yet
// doesn't lose the webhook entirely; server.js logs a boot warning instead.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const header = req.headers["x-hub-signature-256"];
  if (!header || !header.startsWith("sha256=") || !req.rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
}

// Same idea as maskPhone, for the handful of log lines that reference an
// email address instead of a phone number.
function maskEmail(email) {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  return (local[0] || "*") + "***@" + domain;
}

module.exports = { maskPhone, maskEmail, verifyMetaSignature };
