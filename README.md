# AXIS[CKO] — Live App (Phase 1–2)

Next.js App Router implementation of the AXIS Signal Console prototype. Migrated from the `axis.html` monolith with Supabase persistence and a server-side Polygon (Massive) proxy.

## Stack

- **Next.js 15** (App Router, TypeScript, Tailwind CSS v4)
- **Supabase** — Auth, Postgres, RLS
- **Polygon.io** — Market data via `/api/massive/*` proxy (no browser CORS)

## Quick start

### 1. Prerequisites

- Node.js 24.x
- A [Supabase](https://supabase.com) project (you create this)
- Optional: [Polygon.io](https://polygon.io) API key for live Fund quotes

### 2. Install & configure

```bash
cd ~/Projects/axis
cp .env.local.example .env.local
# Edit .env.local with your Supabase URL + anon key
npm install
```

### 3. Run database migrations

In the Supabase Dashboard → **SQL Editor**, paste and run, in order:

```
supabase/migrations/001_initial.sql
supabase/migrations/002_productivity.sql
```

Or with Supabase CLI linked to your project:

```bash
supabase db push
```

### 4. Dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — redirects to `/console`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes (auth) | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes (auth) | Supabase anon/publishable key |
| `POLYGON_API_KEY` or `MASSIVE_API_KEY` | No | Server-side Polygon key for live quotes |

See `docs/env.md` for the full required/optional list. On **Vercel**, add required Supabase variables for Preview and Production. Optional provider keys should degrade to setup/not-configured states when absent. Never prefix server-only provider keys with `NEXT_PUBLIC_`.

## Deployment gate

Agents push branches and open PRs after local checks pass. Vercel preview validation and Sentry review happen after the PR is open; Sentry is not a human pre-push blocker, but it remains required evidence before production merge. See `docs/deployment.md`.

## Routes

| Path | Module |
|------|--------|
| `/console` | Console widgets (weather, daylight, agenda, AQI) |
| `/fund` | Portfolio, watchlist, chart, ticker search |
| `/schedule` | Week view with CRUD events |
| `/login` | Supabase email/password auth |
| `/api/massive/*` | Polygon proxy (quote, history, search, snapshot, status) |

## What's implemented vs stubbed

### Implemented

- App shell: sidebar (live profile + sign out), topbar, theme switcher (Dark / Dim / Light / Slate)
- Command palette — ⌘K / Ctrl-K or click the topbar search
- Design tokens from prototype in `src/app/globals.css`; Interface Studio (accent, density, type, companion)
- Supabase Auth + middleware session refresh; API routes return 401 JSON instead of redirecting
- RLS policies on all tables
- Console widget grid with customize/swap → `console_widgets`; capture box → Signals
- Real weather / AQI / daylight widgets via Open-Meteo; markets via Polygon snapshot
- Signals inbox with AI-stub triage → Agenda tasks
- Agenda: categorized tasks, priority filter, drag-sortable morning routine (synced to `user_preferences`)
- Notes: folders + debounced autosave to Supabase
- Fund: holdings/watchlist CRUD (add with shares/cost, remove, persisted), live quotes, ticker search
- Schedule: week/month/day views, add with validation, delete with confirmation
- Spotify: OAuth, sidebar miniplayer (play/pause/next), Listening Vault embed loads pasted links
- Modals + toasts (no `prompt()` / `alert()`)
- `prefers-reduced-motion` and `:focus-visible` rings

### Stubbed / future

- Google Calendar sync; Vitality → Schedule push
- Mail, People, Library, Objectives, Pipeline, Literature, Briefing, Atelier, Supper Club, Debrief (static prototypes, no persistence)
- Plaid / Public.com banking + brokerage (Fund cash-flow tab is static)
- Apple/Google Photos sync (local upload works)
- AI capture parsing, digests, routine rebuild

## Adding your Polygon API key later

1. Sign up at [polygon.io](https://polygon.io) and create an API key.
2. Add to `.env.local`:
   ```
   POLYGON_API_KEY=your_key_here
   ```
3. Restart `npm run dev` (or redeploy on Vercel).
4. On **Fund**, click **Refresh quotes** — live badges appear when quotes succeed.

Check status: `GET /api/massive/status`

## Project structure

```
src/
├── app/
│   ├── console/ fund/ schedule/ login/
│   └── api/massive/{quote,history,search,snapshot,status}/
├── components/
│   ├── console/ fund/ schedule/
│   ├── nav/ theme/ layout/ ui/
├── lib/
│   ├── supabase/ massive/ store/ types/
└── middleware.ts
supabase/migrations/001_initial.sql
```

## Scripts

```bash
npm run dev      # development
npm run build    # production build
npm run start    # production server
npm run lint     # ESLint
```

## Next phases (roadmap)

- **Phase 3:** Agenda, Signals, Notes, real weather/AQI, calendar sync
- **Phase 4:** Vitality, Research pipeline, Control Room settings, AI gateway

## License

Private — AXIS[CKO] personal operating system.
