# Prompt for Cursor / Claude Code — Client Onboarding Wizard

Run only after PROMPT-3 is merged and verified. Copy below the line.

---

You are working on **Sailz** (this repo), live on Railway. Read first:
`server/instance.js`, `server/brain.js`, `server/vapiSync.js`,
`instances/_template/`, `instances/shine-dental/`, `SAILZ-THESIS.md`.

## Mission

A client can set up their own brain from a link — no Sailz labor. The
wizard collects their business knowledge, drafts their instance config,
and seeds the memory system. Onboarding is the moment the brain is BORN
with knowledge; the librarian grows it from there.

## Hard constraints

1. The wizard NEVER writes live config directly — it produces a DRAFT the
   Sailz owner (us) reviews and activates. Same human-gate philosophy.
2. Wizard pages are public but tokenized: `/onboard/:token`, single-use
   tokens created by an authed route. No client login required.
3. Mobile-first, and match the design system (brain.html aesthetic —
   this is the client's first impression of Sailz).
4. Existing routes unchanged; small commits per stage; verify each stage.

## Stage 1 — Token + wizard shell

- `POST /api/onboarding/create` (auth, owner): `{clientName}` → creates
  `db.onboardings` entry `{token, clientName, status:"sent", data:{}}`,
  returns the shareable URL.
- `GET /onboard/:token` serves the wizard (single HTML file,
  `public/onboard.html`). Invalid/used token → friendly "link expired".
- Progress saves per step (`POST /api/onboarding/:token/step`) so clients
  can leave and resume.

## Stage 2 — The steps (keep each screen to one question group)

1. **Basics** — business name, phone, timezone, address.
2. **Hours** — weekly grid, holidays note.
3. **Services** — name, price range, duration; "add another" pattern.
4. **Policies & insurance** — accepted insurers, cancellation policy,
   payment options.
5. **Brain dump (the killer step)** — one big textarea + file upload
   (txt/pdf/docx): "Paste ANYTHING — your price list, your FAQ doc, your
   training manual. Our brain will read it." Server extracts text and
   runs Claude to structure it into profile fields + proposed memory
   facts. Show the client what the brain understood, let them correct it.
6. **Voice & tone** — how formal, greeting phrasing, things the assistant
   must never say.
7. **The interview** — chat UI, brain asks up to 8 adaptive follow-up
   questions about gaps it noticed ("You mentioned implants — do you offer
   free consultations for those?"). Answers become memory facts.
8. **Done** — "Your brain is being prepared" + what happens next.

## Stage 3 — Draft assembly + activation

- Completion assembles `instances/<slug>/` draft IN THE DATABASE
  (`onboarding.draft = {instance.json, clinic-profile.json, messages.json,
  memoryFacts[]}`) — not on disk.
- Sailz owner review screen (authed): side-by-side draft vs template,
  edit inline, then "Activate" writes the files to `instances/<slug>/`,
  seeds approved memory facts, and (if VAPI env present) dry-runs the
  assistant prompt build for review.
- Activation logs an attention item + emails us (notify.js).

## Stage 4 — Coverage-gap learning (closes the evolution loop)

- In the Vapi webhook, when a call summary/analysis indicates an
  unanswered question (add `unansweredQuestions` to the assistant's
  structuredData schema — instruct in the prompt build), store each as a
  `faq_gap` proposed memory fact with source "call".
- The librarian dedups these against existing knowledge; the approval →
  sync loop (PROMPT-3) does the rest. Result: every question the
  receptionist fumbles becomes next week's knowledge, forever.

## Stage 4.5 — Account handoff polish (small, do not skip)

- **Forgot password**: `POST /api/auth/forgot` (rate-limited 3/hour/IP) —
  if the email exists, send a single-use, 30-min reset token link via
  notify.js/Resend; `POST /api/auth/reset` consumes it. Uniform response
  whether or not the email exists (no account oracle). No-op with a
  logged warning when RESEND_API_KEY is missing.
- **Force change on first login**: users get `mustChangePassword: true`
  when created by seed or invite; login response includes the flag and the
  frontend routes straight to the change-password screen before anything
  else. Cleared on successful change.
- **Magic-link login (optional third path)**: `POST /api/auth/magic` —
  single-use, 15-min emailed login link for existing users. Same uniform-
  response + rate-limit rules. Password login remains available.

## Stage 5 — Verification

```bash
# create token (auth) → GET /onboard/:token 200; bad token → friendly page
# walk all steps via API with fixture data incl. a pasted FAQ text →
#   draft contains structured services/policies + >=3 proposed memory facts
# owner review screen renders draft; Activate writes instances/<slug>/,
#   files parse, brain.js picks up any agent overrides, graph unaffected
# reused token → expired page; unauthed create → 401
# auth polish: forgot → uniform 200 for real + fake emails; reset token
#   single-use + expires; login with mustChangePassword returns the flag;
#   magic link logs in once then dies; all three no-op gracefully w/o Resend
# fake Vapi payload with unansweredQuestions → faq_gap facts proposed
node --check all changed files; all prior regression checks pass
```

## Out of scope

Payment collection, calendar OAuth (manual share instructions for now),
auto-provisioning Vapi numbers, multi-language.
