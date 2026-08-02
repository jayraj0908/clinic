#!/usr/bin/env node
// Pull an activated/completed onboarding draft from a deployed Sailz HQ
// and write instances/<slug>/ locally so it can be committed to git.
//
// Why this exists: activating on a deployed service writes the instance
// folder into that container's ephemeral filesystem — gone on next
// redeploy. The DRAFT, however, lives in the DB (volume) forever. This
// script turns that draft into committed engine config, which is the
// real source of truth.
//
// Usage:
//   node scripts/pull-onboarding.mjs <hq-url> <owner-email> [onboarding-id]
//   (password prompted, never passed as an argument)
// Example:
//   node scripts/pull-onboarding.mjs https://hq.sailz.org jayraj0908@gmail.com
//
// With no id, lists all onboardings and exits. With an id, writes
// instances/<slug>/ from the draft (refusing to overwrite an existing
// folder unless --force).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [hqUrl, email, obId] = process.argv.slice(2);
const force = process.argv.includes("--force");
if (!hqUrl || !email) {
  console.error("Usage: node scripts/pull-onboarding.mjs <hq-url> <owner-email> [onboarding-id] [--force]");
  process.exit(1);
}
const base = hqUrl.replace(/\/+$/, "");

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(q);
      process.stdin.on("data", (c) => {
        if (c.toString() === "\n" || c.toString() === "\r\n") process.stdout.write("\n");
      });
      rl.question("", (a) => { rl.close(); resolve(a); });
      rl._writeToOutput = () => {}; // don't echo password
    } else {
      rl.question(q, (a) => { rl.close(); resolve(a); });
    }
  });
}

async function api(p, opts = {}, token) {
  const res = await fetch(base + p, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const password = await ask(`Password for ${email}: `, true);
const { token } = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
if (!token) { console.error("Login failed."); process.exit(1); }

if (!obId) {
  const list = await api("/api/onboarding/admin", {}, token);
  const items = Array.isArray(list) ? list : list.onboardings || [];
  console.log("\nOnboardings on this HQ:");
  for (const o of items) console.log(`  ${o.id}  ${o.clientName || "?"}  status=${o.status}`);
  console.log("\nRe-run with an id to pull one.");
  process.exit(0);
}

const o = await api(`/api/onboarding/admin/${obId}`, {}, token);
const ob = o.onboarding || o;
const draft = ob.draft || {};
if (!draft || Object.keys(draft).length === 0) {
  console.error("This onboarding has no draft assembled yet (client may not have completed it).");
  process.exit(1);
}

// server/onboarding.js's buildDraftFromOnboarding() returns
// {instanceJson, clinicProfileJson, messagesJson, memoryFacts,
// clientGoals} — camelCase, no file-extension keys. The old fallbacks
// below (draft["instance.json"]/draft.instance/etc.) never matched
// anything real; kept only as harmless extra robustness in case the
// draft shape ever changes again.
const meta = draft.instanceJson || draft["instance.json"] || draft.instance || {};
const slug = meta.id || (ob.clientName || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dir = path.join(process.cwd(), "instances", slug);
if (fs.existsSync(dir) && !force) {
  console.error(`instances/${slug}/ already exists — re-run with --force to overwrite.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const files = {
  "instance.json": draft.instanceJson || draft["instance.json"] || draft.instance,
  "clinic-profile.json": draft.clinicProfileJson || draft["clinic-profile.json"] || draft.profile,
  "messages.json": draft.messagesJson || draft["messages.json"] || draft.messages,
};
for (const [name, content] of Object.entries(files)) {
  if (!content) continue;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(content, null, 2) + "\n");
  console.log(`  wrote instances/${slug}/${name}`);
}
const facts = draft.memoryFacts || draft.memory || [];
if (facts.length) {
  fs.writeFileSync(path.join(dir, "onboarding-memory-seed.json"), JSON.stringify(facts, null, 2) + "\n");
  console.log(`  wrote instances/${slug}/onboarding-memory-seed.json (${facts.length} facts)`);
}
// Not engine-consumed at runtime — informational only, so whoever builds
// this instance's agent overrides has the client's own goals wording
// (the onboarding "what should your brain take off your plate?" step)
// verbatim in front of them instead of having to re-fetch the draft.
if (draft.clientGoals && (draft.clientGoals.chips?.length || draft.clientGoals.badWeekText)) {
  fs.writeFileSync(path.join(dir, "onboarding-goals.json"), JSON.stringify(draft.clientGoals, null, 2) + "\n");
  console.log(`  wrote instances/${slug}/onboarding-goals.json`);
}
if (draft.agents && typeof draft.agents === "object" && !Array.isArray(draft.agents)) {
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  for (const [fname, body] of Object.entries(draft.agents)) {
    fs.writeFileSync(path.join(dir, "agents", fname), body);
    console.log(`  wrote instances/${slug}/agents/${fname}`);
  }
}
console.log(`\nDone. Review the files, then:\n  git add instances/${slug} && git commit -m "Instance: ${slug} from onboarding ${obId}" && git push\nThen create the Railway service with INSTANCE=${slug} per DEPLOY checklist.`);
