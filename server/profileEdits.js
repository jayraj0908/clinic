// Diffs a structured extraction (server/ingest.js's structureCorpus /
// extractImageProfile output shape) against the LIVE clinic profile, and
// applies an approved diff to that profile in place. Used by the "Teach
// Your Brain" surface (server.js's /api/profile-edits routes): a menu
// photo that mentions a price the profile doesn't have yet becomes a
// PROPOSED edit with a before/after preview, never a silent overwrite.
//
// applyProfileEdit mutates the passed-in profile object's own arrays/fields
// rather than reassigning it, because server/instance.js's `profile` export
// is a plain object every other module (agents.js, vapiAssistant.js) already
// holds a reference to — mutating in place means an approval is live for the
// very next call with no redeploy, and (server/instance.js) replays
// previously-approved edits the same way at boot so it survives a restart.

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function diffProfileFragment(profile, fragment) {
  if (!fragment) return null;
  const diff = {};

  if (fragment.services?.length) {
    const existingByName = new Map((profile.services || []).map((s) => [norm(s.name), s]));
    const add = [], change = [];
    for (const s of fragment.services) {
      if (!s.name) continue;
      const price = s.priceRange || s.price || "";
      const existing = existingByName.get(norm(s.name));
      if (!existing) {
        add.push({ name: s.name, price, duration: s.duration || "" });
      } else if (norm(price) !== norm(existing.price) || norm(s.duration) !== norm(existing.duration)) {
        change.push({
          name: existing.name,
          from: { price: existing.price || "", duration: existing.duration || "" },
          to: { price: price || existing.price || "", duration: s.duration || existing.duration || "" },
        });
      }
    }
    if (add.length || change.length) diff.services = { add, change };
  }

  if (fragment.hours?.length) {
    const existingByDay = new Map((profile.hours || []).map((h) => [norm(h.days), h]));
    const add = [], change = [];
    for (const h of fragment.hours) {
      if (!h.days) continue;
      const existing = existingByDay.get(norm(h.days));
      if (!existing) {
        add.push({ days: h.days, open: h.open || null, close: h.close || null });
      } else if (norm(h.open) !== norm(existing.open) || norm(h.close) !== norm(existing.close)) {
        change.push({
          days: existing.days,
          from: { open: existing.open || null, close: existing.close || null },
          to: { open: h.open || existing.open || null, close: h.close || existing.close || null },
        });
      }
    }
    if (add.length || change.length) diff.hours = { add, change };
  }

  if (fragment.insuranceAccepted?.length) {
    const existing = new Set((profile.insuranceAccepted || []).map(norm));
    const add = fragment.insuranceAccepted.filter((x) => x && !existing.has(norm(x)));
    if (add.length) diff.insuranceAccepted = { add };
  }

  if (fragment.policies?.length) {
    const existing = new Set((profile.policies || []).map(norm));
    const add = fragment.policies.filter((x) => x && !existing.has(norm(x)));
    if (add.length) diff.policies = { add };
  }

  if (fragment.selfPay && norm(fragment.selfPay) !== norm(profile.selfPay)) {
    diff.selfPay = { from: profile.selfPay || "", to: fragment.selfPay };
  }

  return Object.keys(diff).length ? diff : null;
}

function applyProfileEdit(profile, diff) {
  if (!diff) return;
  if (diff.services) {
    profile.services = profile.services || [];
    diff.services.add.forEach((s) => profile.services.push({ name: s.name, price: s.price || "", duration: s.duration || "" }));
    diff.services.change.forEach((c) => {
      const existing = profile.services.find((s) => norm(s.name) === norm(c.name));
      if (existing) { existing.price = c.to.price; existing.duration = c.to.duration; }
    });
  }
  if (diff.hours) {
    profile.hours = profile.hours || [];
    diff.hours.add.forEach((h) => profile.hours.push({ days: h.days, open: h.open, close: h.close }));
    diff.hours.change.forEach((c) => {
      const existing = profile.hours.find((h) => norm(h.days) === norm(c.days));
      if (existing) { existing.open = c.to.open; existing.close = c.to.close; }
    });
  }
  if (diff.insuranceAccepted) {
    profile.insuranceAccepted = [...(profile.insuranceAccepted || []), ...diff.insuranceAccepted.add];
  }
  if (diff.policies) {
    profile.policies = [...(profile.policies || []), ...diff.policies.add];
  }
  if (diff.selfPay) {
    profile.selfPay = diff.selfPay.to;
  }
}

module.exports = { diffProfileFragment, applyProfileEdit };
