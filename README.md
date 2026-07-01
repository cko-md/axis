# AXIS[CKO] - Personal Operating System

AXIS is a private Next.js dashboard for running a personal operating system: command center, dispatch, schedule, agenda, mail, notes, objectives, research, people, finances, health, media, and settings in one cohesive App Router app.

The app is integrations-heavy. Supabase is the persistence and auth layer; Vercel hosts preview and production; Sentry captures client/server/edge errors; Composio and direct OAuth power provider workflows; Make handles automation/webhooks; Polygon/Massive, Plaid/Public.com, Spotify, Strava, and AI providers back specific modules where configured. Optional provider keys must degrade gracefully to setup, disconnected, or not-configured states.

## Stack

- **Next.js 15** App Router, TypeScript, React 19, Tailwind CSS v4
- **Supabase** Auth, Postgres, Storage, RLS
- **Sentry** Next.js client/server/edge observability
- **Vercel** preview and production deployments
- **Composio** integration sessions and tool execution, alongside direct OAuth where implemented
- **AI providers** through the app AI router and module-specific actions
- **Polygon/Massive** market data proxy via `/api/massive/*`
- **Plaid / Public.com** partial finance integrations with configured/unconfigured states
- **Spotify / Strava** media and training integrations
- **TipTap**, dnd-kit, Upstash rate limiting, WebAuthn/passkeys, Zod

Tembo role is unspecified in inspected repo config. Do not route data to Tembo or claim a Tembo role unless future configuration proves it.

## Quick Start

### Prerequisites

- Node.js 24.x
- A Supabase project
- Optional provider credentials for the integrations you want to exercise locally

### Install And Configure

```bash
cd ~/Projects/axis
cp .env.local.example .env.local
npm install
```

Edit `.env.local` with the required Supabase values and any optional provider keys. Never expose server-only provider keys with a `NEXT_PUBLIC_` prefix.

### Database Migrations

This repo currently has many migrations in `supabase/migrations`, including numeric, decimal-like, and timestamped filenames. Do not run only `001_initial.sql` and `002_productivity.sql`; that instruction is stale.

For a linked Supabase project, use the Supabase CLI or configured connector to inspect and apply the complete migration set:

```bash
supabase db push
```

Before production schema work, confirm migration ordering and applied state. The current migration ordering remains a production-readiness risk; see `docs/audits/axis-current-state-2026-06-30.md`.

### Dev Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Signed-in users are routed into the AXIS dashboard.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL for browser/server auth and data access. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/publishable key. |
| `NEXT_PUBLIC_SENTRY_DSN` | No locally | Enables Sentry capture when configured. |
| `SENTRY_AUTH_TOKEN` | Build/CI only | Allows Sentry source-map upload in Vercel/CI. |
| `POLYGON_API_KEY` or `MASSIVE_API_KEY` | Optional | Server-side market data key for Fund and market widgets. |

See `docs/env.md` for the full required/optional list. Optional provider keys should show visible setup or not-configured states when absent, not crash the app or present fake live data.

## Surfaced Modules

Status comes from `src/lib/store/nav.ts`.

| Section | Route | Module | Status | Notes |
|---|---|---|---|---|
| Daily | `/command` | Command | production | Canonical console route. `/console` still exists as a legacy duplicate. |
| Daily | `/dispatch` | Dispatch | production | Canonical signals route. `/signals` still exists as a legacy duplicate. |
| Daily | `/schedule` | Schedule | production | Week/month/day scheduling surface. |
| Daily | `/agenda` | Agenda | production | Ranked tasks and routine planning. |
| Daily | `/mail` | Mail | production | Gmail/Outlook through direct OAuth and Composio adapters; provider parity needs live validation. |
| Daily | `/notes` | Notes | production | TipTap-backed notes and artifacts. |
| Plan | `/objectives` | Objectives | beta | Usable goal tracking; needs deeper review/error/persistence validation. |
| Plan | `/debrief` | Debrief | beta | Reflection capture is usable; reminder and AI summary flows need validation. |
| Research | `/pipeline` | Pipeline | beta | Study/conference tracking persists; workflow hardening remains. |
| Research | `/literature` | Literature | beta | Live source search works; saved/custom topic persistence has beta caveats. |
| Life | `/people` | People | beta | CRM records persist; contacts matching/provider parity need validation. |
| Life | `/briefing` | Briefing | beta | Feed reading is usable; source discovery and saved items need hardening. |
| Capital | `/fund` | Fund | beta | Provider-heavy finance module with partial Plaid/Public.com coverage. |
| Labs | `/vitality` | Vitality | lab | Mixes Strava, local-only, and coming-soon health workflows. |
| Labs | `/atelier` | Atelier | lab | Creative discovery and moodboard workflow. |
| Labs | `/listening-vault` | Listening Vault | lab | Spotify-dependent music room. |
| Labs | `/library` | Library | lab | Uploads exist; broader workflow needs storage/RLS/error validation. |
| Labs | `/supper-club` | Supper Club | lab | Local-only exploratory recipe curation. |
| System | `/control-room` | Control Room | production | Settings and integrations hub. |

## Route Inventory

### Page Routes

| Route | Purpose |
|---|---|
| `/` | Entry/redirect route. |
| `/login` | Supabase auth, MFA, passkeys. |
| `/command`, `/console` | Command console; `/command` is canonical. |
| `/dispatch`, `/signals` | Dispatch/signals; `/dispatch` is canonical. |
| `/schedule` | Schedule module. |
| `/agenda` | Agenda module. |
| `/mail` | Mail module. |
| `/notes` | Notes module. |
| `/objectives` | Objectives module. |
| `/debrief` | Debrief module. |
| `/pipeline` | Pipeline module. |
| `/literature` | Literature module. |
| `/people` | People module. |
| `/briefing` | Briefing module. |
| `/fund` | Fund overview. |
| `/fund/investing`, `/fund/watchlist`, `/fund/market` | Fund investing/watchlist/market views. |
| `/fund/spending`, `/fund/cashflow`, `/fund/net-worth` | Fund cash-flow and net-worth views. |
| `/fund/forecasting`, `/fund/advisor`, `/fund/position/[symbol]` | Fund forecasting, advisor, and position detail views. |
| `/vitality` | Vitality module. |
| `/atelier` | Atelier module. |
| `/listening-vault` | Listening Vault module. |
| `/library` | Library module. |
| `/supper-club` | Supper Club module. |
| `/control-room` | Control Room module. |
| `/oauth-done` | OAuth popup completion route. |
| `/privacy`, `/terms` | Legal pages. |

### API Route Groups

| Group | Routes |
|---|---|
| Mail | `/api/mail/*` |
| Calendar | `/api/calendar/*` |
| Contacts / People | `/api/contacts/*`, `/api/people/*` |
| Integrations | `/api/integrations/composio/*` |
| Widgets | `/api/widgets/*`, including `/api/widgets/batch` for batched widget refreshes |
| Fund / markets | `/api/fund/*`, `/api/massive/*`, `/api/plaid/*`, `/api/brokerage/*` |
| AI / search | `/api/ai`, `/api/signals-ai`, `/api/embeddings`, `/api/search/*`, scan routes |
| Briefing / feeds | `/api/briefing/*`, `/api/feeds/*` |
| Auth | `/api/auth/*` |
| Spotify / Strava / health | `/api/spotify/*`, `/api/strava`, `/api/health/*/connect` |
| Cron | `/api/cron/daily`, `/api/cron/finance-daily`, `/api/cron/feed-digest`, `/api/cron/intelligence-sweep` |
| Misc | Proxy, OG image, gallery, literature, notes media, avatar, Tavily, webhooks |

Only `/api/cron/daily` and `/api/cron/finance-daily` are scheduled in `vercel.json` today.

## Production / Beta / Lab / Future

| Status | Modules |
|---|---|
| Production | Command, Dispatch, Schedule, Agenda, Mail, Notes, Control Room |
| Beta | Objectives, Debrief, Pipeline, Literature, People, Briefing, Fund |
| Lab | Vitality, Atelier, Listening Vault, Library, Supper Club |
| Future / blocked | Widget platform validation/polish, cache-first widget behavior hardening, migration-order cleanup, live provider validation, and additional adapter coverage are tracked as follow-up issues rather than claimed as complete here. |

## Scripts

| Purpose | Command |
|---|---|
| Development | `npm run dev` |
| Production build | `npm run build` |
| Production server | `npm run start` |
| Lint | `npm run lint` |
| Unit tests | `npm run test` |
| Public e2e tests | `npm run test:e2e` |
| Authenticated e2e tests | `npm run test:e2e:auth` |
| Typecheck | `npx tsc --noEmit` |

## Deployment Gate

Agents push branches and open PRs after local checks pass. Vercel preview validation and Sentry review happen after the PR is open; Sentry is not a human pre-push blocker, but it remains required evidence before production merge. Supabase/Tembo validation is required for schema work; this repo does not currently specify Tembo's role.

Merging to `main` is the production trigger. This repo also contains `.github/workflows/deploy.yml`, which runs `npx vercel deploy --prod` on pushes to `main`; confirm whether Vercel Git integration, the GitHub Actions workflow, or both are active before approving a production merge. Run `npm run build` locally before merging runtime behavior changes.

## Project Structure

```text
src/
  app/                  App Router pages and route handlers
  components/           Module UI plus shared layout/nav/theme/ui components
  lib/                  Provider logic, hooks, stores, Supabase, integrations, widget registry
supabase/migrations/    SQL migrations; ordering must be validated before schema work
docs/                   Audits, architecture notes, deployment/env docs
```

## Current Truth Sources

- `docs/audits/axis-current-state-2026-06-30.md`
- `src/lib/store/nav.ts`
- `package.json`
- `docs/architecture/integration-adapters.md`
- `docs/audits/axis-platform-audit.md`

## License

Private - AXIS[CKO] personal operating system.
