// Bulk lead import — CSV only for v1. XLSX was in the original spec, but
// the only two maintained npm packages for it right now carry unpatched
// vulnerabilities (xlsx: high-severity prototype pollution/ReDoS, no fix
// available; exceljs: pulls in a large legacy dependency tree with its own
// moderate-severity issues) — not worth it for a format every spreadsheet
// tool (Excel, Sheets, any CRM export) already exports as CSV. Revisit if
// SheetJS ships a clean npm release.
//
// Consent attestation is enforced at the CALLER (server.js's route), not
// here — this module never writes a batch without one, but the actual
// "was it provided" check happens before this is even invoked, so a 400
// never touches the parser at all.

// Minimal RFC4180-ish CSV parser — no dependency needed for something this
// bounded. Handles quoted fields (commas/newlines inside quotes), escaped
// "" quotes, and both \r\n and \n line endings.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\r") {
      // skip — \n (bare or following \r) closes the row
    } else if (c === "\n") {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length || row.length) pushRow();
  // Drop a trailing fully-empty row (a file ending in a newline parses to
  // one extra [''] row) and any genuinely blank line mid-file.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

// US-centric on purpose, matching the rest of this codebase (quiet hours,
// area-code-free phone display, etc. all already assume US numbers).
// Returns null (never throws) for anything that isn't a plausible number,
// so the caller can count it as "invalid" rather than importing garbage.
function normalizePhoneE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (hasPlus) {
    return digits.length >= 8 && digits.length <= 15 ? "+" + digits : null;
  }
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+" + digits;
  return null;
}

// Header → field guesses, so the column-mapping UI starts pre-filled
// instead of blank. The owner can always override before confirming —
// this never affects what actually gets imported, only the UI's defaults.
const HEADER_ALIASES = {
  name: ["name", "full name", "contact name", "contact"],
  phone: ["phone", "phone number", "mobile", "cell", "cell phone", "telephone"],
  email: ["email", "email address", "e-mail"],
  company: ["company", "business", "organization", "employer"],
  notes: ["notes", "note", "comment", "comments"],
  timezone: ["timezone", "time zone", "tz"],
};
function guessMapping(headers) {
  const mapping = {};
  const norm = (h) => String(h || "").trim().toLowerCase();
  const normalized = headers.map(norm);
  for (const field of Object.keys(HEADER_ALIASES)) {
    const idx = normalized.findIndex((h) => HEADER_ALIASES[field].includes(h));
    if (idx !== -1) mapping[field] = idx;
  }
  return mapping;
}

// mapping: {name, phone, email, company, notes, timezone} -> column index
// (any but phone may be omitted/undefined). Never throws — a malformed row
// just gets skipped and counted as invalid; one bad row never kills the
// whole batch.
function importBatch(db, { dataRows, mapping, filename, attestedBy }) {
  const seenThisBatch = new Set();
  const existingPhones = new Set(
    db.leads.map((l) => l.phone && normalizePhoneE164(l.phone)).filter(Boolean)
  );
  let added = 0, duplicates = 0, invalid = 0;
  const newLeads = [];
  const col = (row, idx) => (idx != null && row[idx] != null ? String(row[idx]).trim() : "");

  for (const row of dataRows) {
    const rawPhone = col(row, mapping.phone);
    const phone = normalizePhoneE164(rawPhone);
    if (!phone) { invalid++; continue; }
    if (existingPhones.has(phone) || seenThisBatch.has(phone)) { duplicates++; continue; }
    seenThisBatch.add(phone);
    newLeads.push({
      id: "L" + Date.now() + Math.random().toString(36).slice(2, 6),
      name: col(row, mapping.name) || "Unknown contact",
      phone,
      email: col(row, mapping.email),
      company: col(row, mapping.company),
      notes: col(row, mapping.notes),
      timezone: col(row, mapping.timezone) || null,
      source: "import",
      batchId: null, // filled in below once the batch id exists
      status: "new",
      dialerState: "queued",
      attempts: 0,
      nextAttemptAt: null,
      createdAt: new Date().toISOString(),
    });
    added++;
  }

  const batch = {
    id: "LB" + Date.now() + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    filename: filename || "upload.csv",
    attestedBy,
    attestedAt: new Date().toISOString(),
    rowCount: dataRows.length,
    added, duplicates, invalid,
  };
  newLeads.forEach((l) => { l.batchId = batch.id; });

  db.leadBatches.push(batch);
  db.leads.unshift(...newLeads);

  return { batch, added, duplicates, invalid };
}

module.exports = { parseCSV, normalizePhoneE164, guessMapping, importBatch };
