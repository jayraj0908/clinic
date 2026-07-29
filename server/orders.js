// Restaurant-vertical order building: menu matching, pricing, prep-time
// estimation. Pure functions over an instance's profile.services (the
// menu) — nothing here touches the store. Only ever invoked from the
// place_order Vapi tool-call handler in server.js, which itself only ever
// fires when an instance's Vapi assistant is configured with that tool
// (Shine Dental's assistant has no such tool, so this module is simply
// never reached for that instance).
function normalizeMenuText(s) {
  return String(s || "").toLowerCase().replace(/^replace\s*—\s*/i, "").replace(/[^\w\s]/g, "").trim();
}

function parsePriceDollars(str) {
  const m = /([\d,]+(?:\.\d{1,2})?)/.exec(String(str || ""));
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g, ""));
}

function parsePrepMinutes(durationText) {
  const m = /(\d+)/.exec(String(durationText || ""));
  return m ? parseInt(m[1], 10) : null;
}

// exact -> substring -> word-overlap, in that order, so a close-enough
// spoken name ("classic burger" for the profile's placeholder "REPLACE —
// Classic Burger") still resolves without over-matching to the wrong item.
function matchMenuItem(name, services) {
  const target = normalizeMenuText(name);
  if (!target) return null;
  let hit = services.find((s) => normalizeMenuText(s.name) === target);
  if (hit) return hit;
  hit = services.find((s) => {
    const n = normalizeMenuText(s.name);
    return n && (n.includes(target) || target.includes(n));
  });
  if (hit) return hit;
  const targetWords = new Set(target.split(/\s+/).filter(Boolean));
  if (!targetWords.size) return null;
  let best = null, bestScore = 0;
  for (const s of services) {
    const words = new Set(normalizeMenuText(s.name).split(/\s+/).filter(Boolean));
    if (!words.size) continue;
    let overlap = 0;
    for (const w of targetWords) if (words.has(w)) overlap++;
    const score = overlap / Math.max(targetWords.size, words.size);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.5 ? best : null;
}

// A requested modifier only adds cost if it matches one of the menu item's
// own listed modifiers (e.g. "cheese +$1") — a free-form request like
// "no onion" that isn't priced on the menu correctly costs nothing.
function matchModifierPrice(requestedText, menuModifiers) {
  if (!requestedText || !Array.isArray(menuModifiers)) return 0;
  const target = normalizeMenuText(requestedText);
  for (const raw of menuModifiers) {
    const label = normalizeMenuText(String(raw).replace(/\+\$?[\d.]+/, ""));
    if (label && (label.includes(target) || target.includes(label))) {
      const priceMatch = /\+\$?([\d.]+)/.exec(String(raw));
      return priceMatch ? parseFloat(priceMatch[1]) : 0;
    }
  }
  return 0;
}

// Matches every requested item against the menu, prices it (base + any
// priced modifiers), and tracks the slowest item's prep time (the whole
// order's ready time is bounded by its slowest item — quoting anything
// faster would be a promise the kitchen can't keep). Items not on the menu
// come back in `unmatched` instead of silently being dropped or invented.
function buildOrderItems(requestedItems, services) {
  const matched = [];
  const unmatched = [];
  let maxPrepMinutes = null;
  for (const raw of requestedItems || []) {
    const menuItem = matchMenuItem(raw && raw.name, services);
    if (!menuItem) { if (raw && raw.name) unmatched.push(raw.name); continue; }
    const qty = Math.max(1, parseInt(raw && raw.qty, 10) || 1);
    const modifiers = Array.isArray(raw.modifiers) ? raw.modifiers.filter(Boolean) : [];
    const modPrice = modifiers.reduce((sum, mod) => sum + matchModifierPrice(mod, menuItem.modifiers), 0);
    const unitPrice = Math.round((parsePriceDollars(menuItem.price) + modPrice) * 100) / 100;
    matched.push({ name: menuItem.name.replace(/^replace\s*—\s*/i, "").trim(), qty, modifiers, price: unitPrice });
    const prepMins = parsePrepMinutes(menuItem.duration);
    if (prepMins != null && (maxPrepMinutes == null || prepMins > maxPrepMinutes)) maxPrepMinutes = prepMins;
  }
  return { matched, unmatched, prepMinutes: maxPrepMinutes != null ? maxPrepMinutes : 20 };
}

function computeTotal(items) {
  return Math.round(items.reduce((sum, it) => sum + it.price * it.qty, 0) * 100) / 100;
}

// Two item lists are "the same order" if every item/qty/modifier set
// matches — used to no-op an exact-duplicate tool call (a Vapi retry, or
// the assistant calling place_order twice for the same confirmed order)
// without blocking a genuinely different second call (the customer adding
// something) on the same live call.
function sameItems(a, b) {
  if (a.length !== b.length) return false;
  const key = (it) => `${it.name}|${it.qty}|${(it.modifiers || []).slice().sort().join(",")}`;
  const setA = a.map(key).sort().join(";");
  const setB = b.map(key).sort().join(";");
  return setA === setB;
}

module.exports = {
  normalizeMenuText, parsePriceDollars, parsePrepMinutes,
  matchMenuItem, matchModifierPrice, buildOrderItems, computeTotal, sameItems,
};
