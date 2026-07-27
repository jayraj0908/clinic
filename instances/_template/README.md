# New instance checklist

1. Copy this whole folder: `cp -r instances/_template instances/<client-id>`
2. Fill in `instance.json` — id (must match the folder name and the
   `INSTANCE` env var you'll set for this deployment), name, vertical,
   brandColor, timezone.
3. Fill in `clinic-profile.json` — hours, services, insurance, self-pay,
   policies, AI-disclosure line. This feeds both the dashboard and (once
   pasted into Vapi, or auto-synced by a future onboarding wizard) the
   receptionist/setter voice prompts.
4. Optional: copy the reference prompt docs from an existing instance
   (e.g. `instances/shine-dental/inbound-receptionist-prompt.md`) and
   adjust the placeholder business name/details — these are paste-into-
   Vapi reference docs, not live-loaded by the server.
5. Optional agent overrides: if this client needs a different system
   prompt, workflow list, tool set, or schedule for any agent than the
   engine default in `brain/agents/`, add a file at
   `instances/<client-id>/agents/<agent-name>.md` with the same
   frontmatter shape (see `agents/receptionist.md.example` in this
   folder) — it wins over the engine's file of the same name. Only
   override what's different; every other agent still comes from
   `brain/agents/`.
6. Set environment variables for the new deployment (new Railway service,
   or a new `.env` for local/other hosting):
   - `INSTANCE=<client-id>`
   - `OWNER_EMAIL`, `OWNER_PASSWORD` — that deployment's owner login
   - `JWT_SECRET` — a fresh random string, don't reuse another instance's
   - `CLINIC_NAME` / `CLINIC_TIMEZONE` — optional, override instance.json
   - The usual connector keys (Vapi, Google Calendar, Anthropic, etc.)
     from `.env.example`, scoped to this client's own accounts
   - `DB_PATH` if you want the JSON datastore somewhere non-default (each
     instance is its own deployment with its own database — this engine
     is not multi-tenant-in-one-process)
7. Deploy: new Railway service (or your own host) from this same repo,
   with the env vars above. Point that client's Vapi Server URL at the
   new deployment's `/webhooks/vapi`.
8. `npm run seed` on first boot (or let the server's auto-seed-on-first-
   boot guard do it) to create the owner login and empty database.
