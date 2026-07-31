// HQ-only: polls every registered client's GET /api/heartbeat on a timer
// and on demand, keeps a rolling 7-day snapshot history in db.clients[].
// startPolling() is only ever called from server.js inside the
// SAILZ_ADMIN gate — a plain client deployment never polls anyone, it
// only ever ANSWERS heartbeat requests (see server/heartbeat.js).
const { load, save, log } = require("./store");

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

async function pollOne(client) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let snap;
  try {
    const res = await fetch(`${client.baseUrl}/api/heartbeat`, {
      headers: { "x-sailz-hq-key": client.key },
      signal: controller.signal,
    });
    if (!res.ok) {
      snap = { ts: new Date().toISOString(), ok: false, error: `HTTP ${res.status}` };
    } else {
      const data = await res.json();
      snap = { ts: new Date().toISOString(), ok: true, data };
    }
  } catch (e) {
    snap = { ts: new Date().toISOString(), ok: false, error: e.name === "AbortError" ? "Timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
  client.heartbeats = client.heartbeats || [];
  client.heartbeats.push(snap);
  const cutoff = Date.now() - SEVEN_DAYS;
  client.heartbeats = client.heartbeats.filter((h) => new Date(h.ts).getTime() >= cutoff);
  return snap;
}

async function pollAll() {
  const db = load();
  for (const c of db.clients || []) {
    await pollOne(c);
  }
  save();
}

// healthy: last poll succeeded, recently (within 2x the poll interval).
// stale: no heartbeat yet, or the last successful one is too old (the
// client may be down, or HQ itself may have been offline for a while).
// error: the most recent poll attempt itself failed (bad key, network
// error, non-200).
function clientStatus(c) {
  const last = c.heartbeats && c.heartbeats[c.heartbeats.length - 1];
  if (!last) return "stale";
  if (!last.ok) return "error";
  const age = Date.now() - new Date(last.ts).getTime();
  return age > POLL_INTERVAL_MS * 2 ? "stale" : "healthy";
}

let timer = null;
function startPolling() {
  if (timer) return; // idempotent — safe to call once at boot
  const run = () => pollAll().catch((e) => log("error", `HQ client poll failed: ${e.message}`));
  timer = setInterval(run, POLL_INTERVAL_MS);
  setTimeout(run, 5000); // an early poll shortly after boot, not a 10-minute wait for the first data point
}

module.exports = { pollOne, pollAll, clientStatus, startPolling, POLL_INTERVAL_MS };
