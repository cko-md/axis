# AXIS Agent Instructions

> Repository instruction file for autonomous coding agents (Codex, Claude Code, GitHub agents, and others).
> This file is **agent-neutral**. It is the durable source of truth for how work is scoped, built, validated, and shipped in this repo. Read it in full before starting any task.
>
> Source note: there is no root `CLAUDE.md` in this repo. This file was assembled from the repository structure and the current docs (`docs/audits/axis-platform-audit.md`, `docs/linear/axis-mvp-issues.md`, `docs/architecture/integration-adapters.md`). When those docs and this file disagree, see §14 for precedence.

---

## 1. Project summary

AXIS is a personal operating system: one private Next.js 15 (App Router) dashboard that unifies a person's calendar, email, tasks, notes, health, finances, reading, and media into a single command center. It is modular — each domain (Mail, Dispatch, Schedule, Agenda, Fund, Vitality, Notes, People, etc.) is its own module reached from a shared `AppShell` + sidebar navigation. It is integrations-heavy: most modules are backed by third-party providers (Gmail/Outlook, Google Calendar/Contacts, Spotify, Strava, Polygon/Massive markets, Plaid/Public.com) reached either by direct OAuth or through Composio, with Make as an automation/workflow layer. Persistence and auth are Supabase (Postgres + RLS). The product bar is high: the user expects a premium, cohesive, low-latency dashboard, not a collection of disconnected screens. The single most important rule: **ship complete vertical slices, not visual prototypes** — a feature is only "done" when the full workflow works end to end. Previous agent work repeatedly shipped UI that rendered but did not complete the workflow (e.g. Mail inbox rows render but messages do not reliably open into readable detail, especially for Composio-connected accounts). That class of failure is what these instructions exist to prevent.

---

## 2. Non-negotiable agent behavior

- **Work one Linear issue at a time.** One issue → one branch → one PR.
- **Do not build partial UI prototypes.** No screens that render but don't function.
- **Every feature must support the full workflow:** `list → detail → action → persistence → feedback → error state`. If any link is missing, the feature is not done.
- **Do not create fake "live" data.** No hardcoded metrics, placeholder rows, or mock numbers presented as real. Anything demo-only must be explicitly labeled in the UI.
- **Do not silently fail.** Every provider/network/DB failure must be visible to the user (toast/inline error) and observable (Sentry). Swallowed `catch` blocks are not acceptable.
- **Do not expose secrets.** No keys, tokens, or credentials in code, logs, responses, docs, commit messages, or PR descriptions.
- **Do not log tokens, email bodies, private message content, or raw OAuth payloads.** Log safe metadata only (see §9).
- **Do not make broad unrelated refactors.** Touch only what the issue requires.
- **Do not mix multiple modules in one PR** unless the Linear issue explicitly spans them.
- **Do not change database schema without a migration and an RLS review.** See §8.
- **Do not assume Tembo's role.** Inspect configuration and document whether it is primary Postgres, analytics Postgres, a queue/cache, or unused. Do not route data to it on assumption.
- **Preserve existing behavior** unless the issue explicitly requires changing it. Reuse existing functions/components; delegate to them rather than reimplementing.

---

## 3. Delivery workflow

The delivery system is:

```
Linear issue → agent session → GitHub branch → PR → Vercel preview → Supabase/Tembo validation → post-preview Sentry check → production readiness gate
```

For every issue, the agent must:

1. **Identify the Linear issue** (id + title). If none exists, stop and request one (or split, see §14).
2. **Confirm scope** — restate what is in and out of scope; do not exceed it.
3. **Create or use a dedicated branch** (see naming in §4).
4. **Inspect relevant files** before editing.
5. **Explain current behavior.**
6. **Explain expected behavior.**
7. **Identify database impact** (tables, columns, RLS, migration needed? Supabase + Tembo).
8. **Identify integration/provider impact** (direct OAuth vs Composio; both paths).
9. **Identify Sentry observability needs** (what failures to capture, with what safe metadata).
10. **Implement** the vertical slice.
11. **Run available checks** (`npx tsc --noEmit`, `npm run lint`, `npm run test`; e2e checks when relevant and feasible).
12. **Provide a PR title and description, then push/open the PR after local checks pass.** Sentry review is not a human pre-push blocker.
13. **Provide Vercel preview validation steps.**
14. **Automate Supabase/Tembo validation.** If the issue adds or changes migrations, apply/verify them against the configured Supabase target before production merge using the available CLI/API/connector. If credentials or tooling are unavailable, block production merge unless the PR clearly records the missing automation, the exact migration command/check to run, and the human validation owner.
15. **Automate post-preview Sentry review.** After the Vercel preview is ready, query Sentry for new errors/regressions in the preview window/release/environment using the available CLI/API/connector. If Sentry credentials or tooling are unavailable, block production merge unless the PR clearly records the missing automation, the exact Sentry query/check to run, and the human validation owner.
16. **Provide a manual test checklist** (happy path, error path, refresh/persistence, RLS where relevant, related-module regression).

**Production deploy:** merging the PR into `main` triggers the Vercel **production** deployment (Vercel promotes `main` automatically; only successful builds are promoted). Agents should push branches and open PRs after local checks. Merge only after the Vercel preview, automated Supabase/Tembo validation, automated post-preview Sentry review, and manual workflow checks pass — that is the production-readiness gate. Run `npm run build` locally before merging anything that changes runtime behavior.

End the session with the response format in §12.

---

## 4. Tech stack and commands

**Stack:** Next.js 15 (App Router) · TypeScript (strict) · React 19 · Tailwind CSS v4 · Supabase (`@supabase/ssr`, `@supabase/supabase-js`) · Sentry (`@sentry/nextjs`) · Zod · TipTap (notes editor) · dnd-kit · Upstash (rate limiting) · WebAuthn (`@simplewebauthn/*`). Integrations: Composio, Make, Gmail/Outlook, Google Calendar/Contacts, Spotify, Strava, Polygon/Massive, Plaid/`react-plaid-link` (partial/planned), Public.com (partial/planned). Deployed on Vercel; issues tracked in Linear.

**Commands** (detected in `package.json`):

| Purpose | Command | Notes |
|---|---|---|
| Install | `npm install` | Node 24.x |
| Dev server | `npm run dev` | `next dev` → http://localhost:3000 |
| Build | `npm run build` | `next build` |
| Start (prod) | `npm run start` | `next start` |
| Lint | `npm run lint` | `eslint .` |
| Typecheck | **No npm script.** Use `npx tsc --noEmit` | `tsconfig` has `strict: true`; CI (`.github/workflows/daily-health.yml`) runs `npx tsc --noEmit` + `npm audit`. |
| Unit tests | `npm run test` | `vitest run` |
| Public e2e tests | `npm run test:e2e` | `playwright test --project=public` |
| Authenticated e2e tests | `npm run test:e2e:auth` | `AXIS_E2E_AUTH=1 playwright test --project=authenticated` |

Treat `npx tsc --noEmit` (clean), `npm run lint` (no new errors), and `npm run test` (passing) as the minimum gate for every PR. Run e2e checks when the issue affects browser workflows, auth, navigation, or full user paths.

---

## 5. Repository map

| Path | Purpose |
|---|---|
| `src/app` | App Router pages. Each route is a thin wrapper that renders a module from `src/components/<module>` inside `AppShell`. Includes legal pages, error boundaries (`error.tsx`, `global-error.tsx`, `not-found.tsx`), auth (`/login`, `/auth/callback`). |
| `src/app/api` | Route handlers (~90). Grouped by domain: `mail/*`, `calendar/*`, `contacts/*`, `integrations/composio/*`, `fund/*`, `plaid/*`, `brokerage/*`, `massive/*` (Polygon), `spotify/*`, `strava`, `ai/*`, `widgets/*`, `briefing/*`, `search/*`, `auth/*` (MFA + passkeys), `cron/*`, `webhooks/*`. |
| `src/components` | Module UI (`mail/`, `signals/` (Dispatch), `agenda/`, `schedule/`, `console/` (Command), `control-room/`, `notes/`, `people/`, `fund/`, `vitality/`, `briefing/`, `literature/`, `pipeline/`, `objectives/`, `debrief/`, `library/`, `atelier/`, `vault/` (Listening Vault), `supper-club/`) plus shared `ui/` (Button, Card, Modal, Toast, Skeleton…), `nav/`, `layout/`, `theme/`. |
| `src/lib` | Server/shared logic. |
| `src/lib/mail` | Mail provider logic: `gmail.ts`/`outlook.ts` (direct OAuth), `composio.ts` (Composio), `tokens.ts` (`listMailAccounts` unified account list), and `adapters/` (the `MailAdapter` contract — see §7 and `docs/architecture/integration-adapters.md`). |
| `src/lib/integrations` | `composio.ts` (Composio client, `executeTool`, toolkits), `make.ts`, `tavily.ts`, and the cross-domain `types.ts` (`Result<T>`, `IntegrationError`) + `registry.ts` (provider capabilities). |
| `src/lib/hooks` | Client data hooks (`usePeople`, `useTasks`, `useSignals`, `useNotes`, `useObjectives`, `usePipeline`, `useWidgetData`, etc.) — most do full Supabase CRUD + realtime refresh. |
| `src/lib/store` | Static config: `nav.ts` (navigation map), `widgets.ts`, `fund-defaults.ts`. |
| `supabase/migrations` | SQL migrations (~50 tables). **Numbering is currently inconsistent** (duplicate prefixes, unnumbered files) — see `docs/audits/axis-platform-audit.md` finding A4; do not assume ordering or that a migration is applied in prod. |
| `docs` | `audits/axis-platform-audit.md` (platform audit), `linear/axis-mvp-issues.md` (the issue plan + module order), `architecture/integration-adapters.md` (adapter design + Mail test matrix), `DESIGN_HANDOFF.md`, `agent-handoff/`. |

Routing note: pages are thin (`<AppShell><XModule/></AppShell>`); business logic lives in components + hooks + `src/lib`. Some legacy duplicate routes exist (`/console`↔`/command`, `/signals`↔`/dispatch`) — nav points at `/command` and `/dispatch`.

---

## 6. Product architecture principles

- **Complete vertical slices** are preferred over broad horizontal scaffolding. Build one workflow fully before starting another.
- **UI components should be thin.** Move provider/data logic into hooks and `src/lib` services/adapters. Avoid god components.
- **Provider-specific logic belongs in adapters/services**, never inline in route handlers or components.
- **API routes must validate auth and ownership** before doing work (authenticated user; the referenced account/row belongs to that user).
- **Supabase is the persistence / source-of-truth layer** unless a doc explicitly says otherwise.
- **Composio/Make are workflow/integration layers, not always the low-latency read path.** Don't make a live provider call on the render-critical path when a cached read will do.
- **Prefer cache-first UI for slow third-party providers** — serve last-known data from Supabase immediately, then revalidate in the background.
- **User-facing pages need all states:** loading, empty, error, disconnected, permission-denied, and success. A page that only handles the happy path is incomplete.

---

## 7. Integration architecture

- **Direct OAuth and Composio may coexist.** A given domain can have accounts connected either way; the unified account list (e.g. `listMailAccounts`) carries a `via`/transport marker.
- **Agents must check both paths.** Do not fix or test only one transport.
- **Use adapter contracts** where possible (Mail already has `src/lib/mail/adapters` with a `MailAdapter` interface returning normalized types + structured `Result` errors). Calendar, Contacts, Spotify, Strava, and others should follow the same pattern. Route handlers select an adapter and call generic methods; they must not branch on provider names.
- **Verify provider account ownership before any action** (the account must belong to the authenticated user).
- **Provider failures return structured errors** with safe Sentry metadata (provider, operation, status code, transport, normalized error code) — never tokens or content.
- **Never leak tokens or private content** anywhere (responses, logs, Sentry, docs).

### Mail-specific warning

The Mail module has historically had **provider parity bugs**: inbox listing may work through Composio while message-detail or action routes still assume legacy direct OAuth, so Composio-connected messages fail to open. When working on Mail, always verify the full matrix:

- transports: **direct Gmail**, **direct Outlook**, **Composio Gmail**, **Composio Outlook**
- operations: **list**, **detail**, **send/reply**, **read/archive/delete**
- plus **error states** for each (provider down, auth expired, not found, rate limited)

See `docs/architecture/integration-adapters.md` for the contract and the full manual test matrix.

---

## 8. Database and migrations

- **Inspect existing migrations** (`supabase/migrations`) before adding tables or columns; reuse existing tables where possible.
- **Every new table must include RLS** with owner-scoped policies.
- **Every user-owned row must include `user_id`** and be filtered by `auth.uid()` in RLS.
- **Migrations must be non-destructive** unless destruction is explicitly approved in the issue.
- **Document Supabase and Tembo impact** in the PR. Do not assume Tembo's role — inspect and state whether it is primary Postgres, analytics Postgres, a queue/cache, or unused; route nothing to it on assumption.
- **Do not assume a migration has been applied in production.** Migration numbering in this repo is currently inconsistent (audit finding A4); state explicitly whether your migration is applied and confirm ordering.
- **Automate migration application/verification whenever migrations change.** Use the configured Supabase CLI/API/connector to apply or verify pending migrations for the target environment before production merge. Do not merge migrations to production on "documented steps" alone unless credentials/tooling are unavailable; in that case, mark the production gate blocked and record the exact command/check plus owner in the PR.
- **UI should degrade gracefully when optional schema is absent only when that is explicitly intended.** Silent fallback to `localStorage` instead of Supabase is a known anti-pattern here (audit finding A3) — do not introduce new instances; signed-in writes must hit Supabase or show a visible error.

---

## 9. Observability

- **Sentry captures actionable failures** (`@sentry/nextjs` is configured: `sentry.client/server/edge.config.ts`). Capture provider/DB/network failures that a human would want to see.
- **Log safe metadata only.**
- **Never log** tokens, secrets, full email bodies, OAuth payloads, or any private user content. Redact/hash addresses where an identifier is needed.
- **Provider errors should include** provider, operation, HTTP status code, transport, normalized error code, and safe correlation metadata — nothing sensitive.
- **Do not capture expected 4xx (e.g. not-found) as errors** — use breadcrumbs/info; reserve `captureException` for 5xx-class and unexpected failures.
- **Automate post-preview Sentry review before production merge.** Query Sentry for new issues/regressions in the preview deploy window/release/environment and record the result in the PR or final handoff. If Sentry access is unavailable, do not silently proceed; mark the production gate blocked and include the exact query/check plus owner.
- **PR notes must include Vercel preview validation** (preview deploy succeeded; happy + error paths exercised on the preview URL; no new Sentry error for the happy path). Push/open the PR after local checks; complete automated Sentry review post-preview before production merge.

---

## 10. UX / design rules

- **Use the existing AXIS visual language** and design tokens; render inside `AppShell`.
- **Reuse existing components** (`ui/Card`, `ui/Modal`, `ui/Button`, `ui/Toast`, `ui/Skeleton`, nav patterns) before creating new ones.
- **Maintain a premium, cohesive dashboard feel** — consistent spacing, typography, theming (Dark/Dim/Light/Slate).
- **Avoid fake static metrics.** Real data or an explicit empty/coming-soon state.
- **Every card / list row** must either open a detail view, navigate somewhere useful, or be clearly disabled / marked coming-soon. No dead tiles.
- **Every destructive action** needs confirmation (or undo).
- **Every async action** needs a visible loading state and explicit success/error feedback.

---

## 11. Module priority order

Implement in this order (from `docs/linear/axis-mvp-issues.md`). Do not jump ahead unless an issue says so.

> **Status:** item 1 (integration adapter foundation) is **merged to production** — `src/lib/integrations/{types,registry}.ts` + `src/lib/mail/adapters/*`, with `api/mail/{inbox,message/[id],send}` rewired to it (see `docs/architecture/integration-adapters.md`). The next actionable issue is **item 2, Mail: Composio Gmail detail**.

1. Integration adapter foundation ✅ (merged)
2. Mail: Composio Gmail detail
3. Mail: Composio Outlook detail
4. Mail visible error state
5. Mail reply/send parity
6. Mail archive/delete/mark-read
7. Mail pagination/load-more
8. Mail cache-first architecture
9. Latency pass
10. Env/Sentry/Vercel gate
11. Dispatch
12. Agenda
13. Schedule/Calendar
14. Control Room
15. Console/Command
16. Navigation/IA
17. Notes
18. People
19. Literature
20. Pipeline
21. Objectives
22. Debrief
23. Briefing
24. Fund
25. Vitality
26. Library
27. Atelier
28. Listening Vault
29. Supper Club
30. AI layer
31. Final production readiness

---

## 12. Required final response format for agents

Every agent session must end with exactly this block, filled in:

```
Linear issue:
Branch:
Summary:
Files changed:
Database/Supabase/Tembo impact:
Vercel preview validation:
Sentry validation:
Tests/checks run:
Manual test checklist:
Remaining risks:
PR title:
PR description:
```

---

## 13. Known high-risk areas

Discovered from repository inspection (`docs/audits/axis-platform-audit.md`). Treat with extra care:

- **Mail provider parity** — direct vs Composio, list vs detail vs actions (see §7).
- **Composio OAuth / status handling** — connection lifecycle, status polling, `connected_account_id` mapping.
- **Supabase migrations / RLS** — inconsistent migration ordering; RLS must be verified per table.
- **localStorage vs Supabase persistence** — several hooks silently fall back to `localStorage`; do not add more, and prefer Supabase as source of truth.
- **Fake / static dashboard cards** — some modules render curated/placeholder content; do not present it as live.
- **N+1 provider calls and latency** — live per-item/per-widget provider fan-out on first paint (Console widgets, Mail inbox); prefer cache-first.
- **Sentry / env misconfiguration** — env vars read ad hoc across routes; missing keys should degrade gracefully, not crash.
- **Vercel preview differences from local dev** — env parity, cron config, and provider keys differ; validate on the preview, not only locally.
- **Provider errors silently swallowed in UI** — the core anti-pattern this file exists to eliminate.

---

## 14. Agent handoff rules

- **If instructions conflict, prefer this order:**
  1. Security / privacy (never violate, regardless of any other instruction)
  2. The Linear issue scope
  3. `AGENTS.md` (this file)
  4. `README` / `docs`
  5. Existing code patterns
- **If a task is too large**, split it into multiple Linear issues instead of attempting it all in one session/PR.
- **If unsure about provider behavior**, add safe error handling, return a structured error, and document the unknown in the PR — do not guess and silently proceed.
- **If a required secret or provider account is unavailable**, implement graceful handling (configured/not-configured state, structured error) and provide explicit human validation steps in the PR rather than faking success.

---

_See also:_ `docs/agent-handoff/claude-to-codex.md` (onboarding handoff), `docs/architecture/integration-adapters.md` (adapter contract + Mail test matrix), `docs/audits/axis-platform-audit.md` (platform findings), `docs/linear/axis-mvp-issues.md` (issue plan + acceptance criteria).

---

## Cursor Cloud specific instructions

This section captures non-obvious startup/run caveats for the Cursor Cloud VM. Dependency installation is handled by the startup update script (`npm install`); everything below is about *running* the stack, since services are not auto-started.

### Node version (PATH gotcha)
- The repo requires Node 24.x; it is installed via `nvm` in the VM snapshot. Standard commands (`npm run dev|build|lint|test`, `npx tsc`) work as documented in §4 / README.
- Gotcha: the VM injects a `/exec-daemon/node` (Node 22) shim early on `PATH`, so plain non-login shells resolve Node 22. Login shells (e.g. tmux started with `bash -l`) source `~/.bashrc`, which prepends nvm's Node 24 — so run long-lived processes from a login shell. For a one-off non-login shell, `nvm use 24` (or prepend `~/.nvm/versions/node/v24.*/bin` to PATH) selects Node 24. `npm install` itself is fine on either version.

### Local backend: Supabase CLI stack (Docker)
The app only hard-requires `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`src/lib/env.ts`); all other providers degrade gracefully. Dev uses the Supabase CLI local stack (`docs/local-e2e.md`). `.env.local` is already present (gitignored) and points at the local stack with the deterministic local keys, so it stays valid across reboots.

Startup after a cold VM boot:
1. Start Docker (not auto-started): `sudo dockerd >/var/log/dockerd.log 2>&1 &` then `sudo chmod 666 /var/run/docker.sock`. Docker is v29, so `/etc/docker/daemon.json` must set `storage-driver: fuse-overlayfs` **and** `features.containerd-snapshotter: false` (already configured in the snapshot).
2. Start Supabase: `cd /tmp/axis-sb && npx supabase start` (see the migration caveat below for why a temp workdir is used). API: `http://127.0.0.1:54321`, Studio: `http://127.0.0.1:54323`, Mailpit: `http://127.0.0.1:54334`, DB: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, container `supabase_db_axis`.

Two non-obvious defects mean `supabase start` cannot replay `supabase/migrations` cleanly from scratch (repo audit finding A4):
- **Duplicate migration version:** `011_avatars_bucket.sql` and `011_cleanup_functions.sql` share version `011` → `duplicate key ... schema_migrations_pkey`.
- **Policy conflict:** `027_security_definer_lockdown.sql` re-`create`s policy `avatars_select_owner` (already made by `011`) without dropping it first → hard error that aborts the whole start.

Reproducible workaround (keeps the repo pristine — do NOT commit migration edits):
```bash
# 1. Temp workdir; disable auto-migrations + seed in the COPY's config.toml only
rm -rf /tmp/axis-sb && mkdir -p /tmp/axis-sb && cp -r /workspace/supabase /tmp/axis-sb/supabase
python3 - <<'PY'   # set enabled=false only under [db.migrations] and [db.seed]
import pathlib
p = pathlib.Path("/tmp/axis-sb/supabase/config.toml"); s = p.read_text()
for sect in ("[db.migrations]", "[db.seed]"):
    head, _, tail = s.partition(sect)
    tail = tail.replace("enabled = true", "enabled = false", 1)
    s = head + sect + tail
p.write_text(s)
PY
cd /tmp/axis-sb && npx supabase start          # brings up the stack WITHOUT applying migrations
# 2. Apply every migration in filename order via psql, tolerating the ONE benign
#    "policy avatars_select_owner already exists" error from 027:
for f in $(ls /workspace/supabase/migrations/*.sql | sort); do
  cat "$f" | docker exec -i supabase_db_axis psql -U postgres -d postgres -v ON_ERROR_STOP=0 -q >/dev/null 2>&1
done
# 3. Grant table privileges to the API roles. The new Supabase CLI default does NOT
#    auto-expose public tables to anon/authenticated (see auto_expose_new_tables in
#    config.toml), so without this every REST call 403s with 42501 "permission denied".
docker exec -i supabase_db_axis psql -U postgres -d postgres <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
SQL
```
The Postgres data volume persists on disk, so steps 2–3 are only needed on first init or after `supabase db reset`; a plain restart just needs `npx supabase start` from `/tmp/axis-sb`.

### Dev server
- Run bound to `127.0.0.1` so it matches Supabase auth `site_url` and cookies work: `npm run dev -- --hostname 127.0.0.1` → `http://127.0.0.1:3000`. Use a tmux login shell so Node 24 is active.

### Auth / signup gotcha (not a bug)
- The `/login` sign-up form's submit button stays **disabled until the Terms of Service / Privacy checkbox is checked** (`src/app/login/page.tsx`). Email confirmation is disabled locally (`config.toml` `enable_confirmations = false`), so a checked-Terms signup logs in immediately. Background `400/404` console noise on `/auth/v1/token` from the Supabase client (no session yet) is harmless.
- Verified hello-world: signup → land on `/command` → create a Note in `/notes` → persists across reload (row in `public.notes`).
