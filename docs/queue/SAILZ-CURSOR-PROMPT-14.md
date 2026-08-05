# Prompt for Cursor / Claude Code — Onboarding v2: feed the brain anything

Next build after current ops settle. Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`server/onboarding.js`, `public/onboard.html`, the librarian/memory flow
(`server/server.js` memory routes, `brain/agents/librarian.md`),
`server/notify.js`, MOBILE-AUDIT.md conventions.

## Mission

Clients teach their brain the way humans naturally share knowledge:
talking and dumping files — during onboarding AND forever after. Plus a
"what do you actually want" step that shapes their agent roster.

## Hard constraints

1. Everything ingested becomes PROPOSED knowledge (drafts/facts) — the
   human-approval gate never weakens.
2. Graceful degradation everywhere: no transcription key → audio is
   stored + queued for manual review, never a dead end or a 500.
3. Uploads: enforce per-file size limit (25MB), total cap per
   onboarding (200MB), filetype allowlist; store under the instance's
   data dir; never execute or inline-render uploads.
4. Design system + mobile-first (the wizard is a phone experience).
5. Small commits per stage + verification each.

## Stage 1 — Files: more, and richer types

- Raise the wizard's upload limits: up to 20 files per batch, multiple
  batches, running list with per-file status chips (parsed ✓ / queued /
  failed) and remove buttons.
- New types: images (jpg/png/heic→jpg if trivial, else reject heic with
  a friendly note) and audio (m4a/mp3/wav/webm).
  - Images → Claude vision (Anthropic API supports image input): extract
    menus, price lists, service boards, hour signs into structured
    profile fields + proposed facts. A photo of a paper menu should
    produce the same quality draft as pasted text.
  - PDFs/docx: existing path, keep.
- Each file's extraction shows a "what the brain understood" preview the
  client can correct inline (existing pattern, extend to new types).

## Stage 2 — Voice: let them just talk

- In-browser recording on the brain-dump and interview steps
  (MediaRecorder, webm/opus): big "Hold to talk / tap to stop" control,
  playback + re-record, then upload as an audio file into the same
  pipeline.
- Transcription: optional DEEPGRAM_API_KEY (or ASSEMBLYAI_API_KEY —
  pick one, document in .env.example). Present → transcribe server-side
  → transcript joins the brain-dump text visibly ("Here's what I
  heard — fix anything"). Absent → store audio, mark "saved for the
  Sailz team to review", create an attention item on the ADMIN side so
  we process it manually. Never block the wizard on transcription.
- Also accept uploaded voice-memo files through the same path.

## Stage 3 — "What do you actually want" step

- New early wizard step: "What should your brain take off your plate?"
  - chips (multi-select): answer every call · book appointments/meetings
    · take orders · chase leads fast · reminders & confirmations ·
    reviews & follow-ups · paperwork/notes · something else (free text)
  - one free-text: "Describe a bad week at your business."
- Selections map to a recommended agent set (extend the existing
  vertical→recommendedAgents logic to blend goal chips) and are shown
  on the admin review screen as "what they said they want" — verbatim,
  because sales language comes from client language.

## Stage 4 — Teach Your Brain (post-onboarding, client-facing)

- New "Teach" surface on the client dashboard (owner + staff): the same
  drop-anything uploader + voice recorder, available FOREVER, not just
  during onboarding.
- Everything ingested here flows into the existing memory pipeline as
  proposed facts (librarian dedup applies) — owner approves from the
  same Memory drawer. Profile-shaped extractions (new service, price
  change, hours change) become proposed PROFILE EDITS with a diff
  preview the owner approves; on approve they update the instance
  profile in the DB overlay (not files) so assistant-request serves the
  change on the next call.
- This makes "menu changed? snap a photo of the new menu" a real
  workflow — say so in the empty-state copy.

## Stage 5 — Verification

```bash
# 20-file batch uploads with mixed types; over-limit file rejected
#   politely; total cap enforced
# image of a menu (fixture) → structured items in draft + editable
#   preview; garbage image → graceful "couldn't read this"
# audio with no transcription key → stored + admin attention item;
#   with key (mock the API) → transcript inserted + editable
# goals chips → recommended agents reflect selections; free-text
#   preserved verbatim on admin review
# Teach tab: photo upload → proposed profile edit with diff → approve →
#   /api/vapi/preview-prompt reflects the change (no deploy)
# full regression: wizard v1 flows, memory, catalog, both instances
node --check all changed files
```

## Out of scope

Auto-provisioning on wizard completion (separate milestone), video
uploads, real-time streaming transcription, client-side ML.
