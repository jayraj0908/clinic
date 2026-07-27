# Sailz Brain — agent definitions

This directory is the **brain** of the product, adopting the agents-as-markdown
format from [Everything Claude Code (ECC)](https://github.com/affaan-m/ECC)
(MIT, by Anthropic-hackathon winner Affaan Mustafa). A full reference copy of
ECC lives in `../ecc/` (gitignored — reclone with
`git clone --depth 1 https://github.com/affaan-m/everything-claude-code.git ecc`).

## Format

Every agent is one markdown file in `brain/agents/`:

```yaml
---
name: receptionist          # stable id — matches brainGraph hub id
description: what it does   # shown in UI tooltips / sidebar
tools: vapi, gcal, anthropic # integration ids from store.js
schedule: null              # cron, or null for always-on / event-driven
model: claude-sonnet        # model used for its LLM calls
---
(system prompt body)
```

Skills live in `brain/skills/<skill-name>/SKILL.md` — reusable instruction
blocks that agents reference (same convention as ECC's 281 skills).

## Why files, not code

- **Sellable/modable**: a new client = a new set of markdown files. No code
  changes. A dental clinic and a law firm are just different `brain/` folders.
- **The map grows itself**: `server/brainGraph.js` can enumerate this folder,
  so dropping in a new agent file makes a new node appear on the neural map.
- **The brain learns**: agents append learned rules to their own files (ECC's
  "instincts" pattern) — e.g. the receptionist learns "Mrs. Patel prefers
  Saturday mornings" as a line in a memory file, versioned in git.

## Wiring plan (next step, in `server/agents.js`)

1. On boot, parse `brain/agents/*.md` (frontmatter + body).
2. Use the body as the system prompt for that agent's Claude calls
   (replacing the hardcoded prompts; `server/knowledge-base/*` merges in).
3. `brainGraph.js` builds hubs from these files instead of the HUBS constant.
4. Memory: after each run, append notable facts to
   `brain/memory/<agent>.md` — retrieved into context on the next run.
