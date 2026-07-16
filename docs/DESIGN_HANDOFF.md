# Axis — Design & Product Handoff

> **Audience**: Incoming engineers, designers, and collaborators. Reading this
> document top-to-bottom should give you a working mental model of the platform
> in ~30 minutes. File paths are absolute from the repo root.

---

## Platform Overview

Axis is a personal operating system built for a neuroscience physician-researcher.
It surfaces daily workflow (tasks, calendar, mail, notes), research tooling (pipeline,
literature, signals triage), health tracking (vitality, nutrition), and financial
management in a single glass-panel interface. Every module shares the same sidebar,
topbar, design system, and authentication layer.

**Core principle**: a single authenticated context, cold dark aesthetic, and
contextual AI threading through every module via the Axiom layer (`/api/ai`).

---

## Design System

### Atelier Theme

All tokens live in `src/app/globals.css`. The theme ships in four variants — each
toggled via an `html` class: (default dark), `dim`, `slate`, `light`.

#### Color Palette

| Token | Default | Purpose |
|-------|---------|---------|
| `--bg` | `#0a0b0e` | Page ground — near-black, warm tint |
| `--surface` | `#10131a` | Card / panel base |
| `--surface-2` | `#161a23` | Input backgrounds, nested surfaces |
| `--surface-3` | `#1e222d` | Deeper nested layers |
| `--glass` | `rgba(232,228,220,0.05)` | Translucent glass layer |
| `--glass-2` | `rgba(232,228,220,0.08)` | Active glass state |
| `--line` | `rgba(205,195,177,0.16)` | Default hairline borders |
| `--line-strong` | `rgba(214,204,186,0.28)` | Emphasised borders |
| `--ink` | `#ece8e0` | Primary text — warm bone, never pure white |
| `--ink-2` | `#d4cec2` | Secondary text |
| `--ink-dim` | `#a09891` | Tertiary / label text |
| `--ink-faint` | `#726c62` | Placeholder / ghost text |
| `--gold` / `--accent` | `#c9a463` | Primary accent — molten gold |
| `--gold-2` | `#e0c388` | Bright gold (hover, highlight) |
| `--gold-deep` | `#9a7c46` | Deep gold (eyebrow labels) |
| `--marine` | `#3f6fb0` | Data blue |
| `--marine-2` | `#6f9bc7` | Data blue highlight |
| `--clay` | `#c2603f` | Warning / down |
| `--up` | `#7fa86a` | Positive delta |
| `--down` | `#c2603f` | Negative delta (same as `--clay`) |
| `--r` | `3px` | Default border radius |
| `--rl` | `7px` | Large border radius (cards, modals) |
| `--topbar-h` | `54px` | Topbar height — used for scroll padding |

#### Typography

Font vars are declared on `:root` with hardcoded fallbacks, then overridden on
`body` using `next/font` CSS variables (see `src/app/globals.css` lines 179–183
and `docs/feedback-css-font-vars.md` for the scoping constraint).

| Token | Stack |
|-------|-------|
| `--disp` | Bebas Neue → Archivo Narrow → sans-serif |
| `--narrow` | Archivo Narrow → sans-serif |
| `--serif` | Fraunces → Georgia → serif |
| `--sans` | Archivo → -apple-system → sans-serif |
| `--mono` | JetBrains Mono → monospace |

Body font-size is `13px`, weight `300`. Numeric digits use `tabular-nums`.

#### Effects

- `--blur`: `saturate(135%) blur(52px)` — applied to `.card`, `.sidebar`,
  `.topbar` via `backdrop-filter`.
- `--glow`: gold drop-shadow used on active nav indicators, primary buttons.
- Cinematic depth field (`.depthfield`) renders fixed animated gradients behind
  all content, z-index 0.
- Blueprint grid (`body::before`) — a 54×54px CSS grid texture masked at top.
- Film grain (`.grain`, `z-index: 3`) — SVG noise at 4.5% overlay opacity.

### Component Conventions

#### Layout Shell

`src/components/layout/AppShell.tsx` wraps every authenticated page. It renders
the `Sidebar`, `Topbar`, `WebViewer` overlay, `CommandPalette`, and main scroll
region. Sidebar has three states stored in `localStorage` (`"axis-sidebar"`):
`"open"` (240 px), `"icons"` (62 px), `"hidden"` (slide-out on hover).

#### Page Scaffold

All module pages live under `src/app/{route}/page.tsx`. A typical page renders
a `<div className="view-pad">` containing a `.modhead`, eyebrow label, hero
`h1`, optional `.subtabbar`, and the module component. `view-pad` adds top
padding equal to `topbar-h + 44px` to clear the fixed topbar.

#### SubTabBar

```jsx
<div className="subtabbar">
  <button className={`subtab${tab === "x" ? " on" : ""}`}>Label</button>
</div>
```

Active tab has a 2 px gold underline (`--accent`) with glow. Used in Vitality,
Mail, Fund, ControlRoom, Signals, Schedule, etc.

#### Cards

```jsx
<div className="card">…</div>
<div className="card tick">…</div>  // with gold corner tick marks
```

Glass slab with hairline edge and refractive inner highlight. `tick` variant
adds gold L-shaped corner marks (precision instrument aesthetic).

#### Modal

`src/components/ui/Modal.tsx` — accepts `open`, `onClose`, `title`, `footer`.
Renders as a fixed overlay with glass card. Used throughout; do not use raw
`<dialog>` elements.

#### Toast

`src/components/ui/Toast.tsx` — `useToast()` hook exports `toast(message, type, module)`.
Types: `"success"` | `"error"` | `"warn"` | `"info"`.

#### Button

`src/components/ui/Button.tsx` — variants: `"primary"` (gold fill), `"ghost"` (outline).

#### Capture Bar

```jsx
<div className="capture">
  <svg>…</svg>
  <input placeholder="…" />
  <button className="capt-pill">…</button>
</div>
```

The recurring input motif — appears in Agenda, Notes, Signals, Briefing.

#### Setup State

Modules that require a connection (Mail, Calendar, Strava, Plaid) render a
setup/empty state with an icon, headline, and connect button when the service
is not yet linked. The pattern is a centered card with a descriptive subhead and
a primary CTA.

---

## Module Inventory

### Console (Command) — `/command`

**File**: `src/components/console/ConsoleModule.tsx`
**Status**: Live

**Features**: Animated "Axiom" AI-powered intelligence card stream (calls `/api/ai`
with `action: "context"`). Four tidbit widgets (tasks due, unread mail, schedule
summary, fund delta). Today's timeline pulled from `ScheduleEvent` rows in
Supabase. Featured artwork photo grid via `FeaturedPhotos.tsx` (fetches from
`/api/gallery` or `/api/widgets/`). Persistent day/night clock in topbar.

**Known gaps**: Tidbit counts are partly hardcoded; real counts need live joins
across `tasks`, `mail_tokens`, and `schedule_events` tables.

---

### Agenda — `/agenda`

**File**: `src/components/agenda/AgendaModule.tsx`
**Status**: Live (Supabase-backed)

**Features**: Task list with DnD reordering (`@dnd-kit`). Tasks stored in
`tasks` table (Supabase). Four categories: `research`, `clinical`, `life`,
`personal`. Priority `hi` / `med` / `lo`. Morning and night routine checklists
(localStorage). AI triage via `/api/ai` with `action: "triage"`.

**Hook**: `src/lib/hooks/useTasks.ts` — manages CRUD + optimistic updates.

**Table**: `tasks` — columns include `id`, `user_id`, `title`, `body`, `category`,
`priority`, `completed`, `due_at`, `created_at`.

---

### Schedule — `/schedule`

**File**: `src/components/schedule/ScheduleModule.tsx`
**Status**: Partial — calendar grid live, sync stubs present

**Features**: Week / Month / Day view toggle. Week grid is rendered live.
Month calendar shows static sample events. Day view shows `DAY_SAMPLE_ROWS`
(Phase-3 stub). Calendar sync via `/api/calendar/connect` (Google OAuth2) and
`/api/calendar/disconnect`, `/api/calendar/sync`, `/api/calendar/status`.
Outlook Calendar OAuth also wired at `/api/calendar/callback`.

**Table**: `schedule_events` — columns: `id`, `user_id`, `title`, `start_at`,
`end_at`, `all_day`, `color`, `source` (`google` | `outlook` | `manual`),
`external_id`.

**Known gaps**: Month and Day views still show stub data; live event rendering
in those views is not wired.

---

### Notes — `/notes`

**File**: `src/components/notes/NotesModule.tsx`, `src/components/notes/NotesEditor.tsx`
**Status**: Live (Supabase-backed)

**Features**: Rich text editor (TipTap with tables, task lists, code blocks,
underline). Notes stored in `notes` table. Tags, locking, font variants
(`serif` | `mono` | `display`). DnD note reordering. Full-text search.
Folder view.

**Hook**: `src/lib/hooks/useNotes.ts`

**Table**: `notes` — columns: `id`, `user_id`, `title`, `body` (HTML), `tags`,
`locked`, `font`, `folder`, `created_at`, `updated_at`.

---

### Signals (Dispatch) — `/dispatch`

**File**: `src/components/signals/SignalsModule.tsx`
**Status**: Live (Supabase-backed)

**Features**: Inbox of intelligence signals. Each signal is classified by
`/api/signals-ai` into `action` / `awaiting` / `fyi` with priority and
destination. Routing rules let signals auto-route to Agenda, Pipeline, Fund,
People, etc. One-click triage to tasks. CSS module: `SignalsModule.module.css`.

**Hooks**: `src/lib/hooks/useSignals.ts`, `src/lib/hooks/useSignalRoutes.ts`

**Table**: `signals` — columns: `id`, `user_id`, `title`, `body`, `source`,
`signal_type`, `priority`, `destination`, `routed_at`, `read_at`, `created_at`.

---

### Mail — `/mail`

**File**: `src/components/mail/MailModule.tsx`
**Status**: Live (OAuth-gated)

**Features**: Gmail + Outlook inbox with threaded message view. OAuth connect
flows at `/api/mail/connect` (Google) and Outlook equivalents. Message list,
full message body (HTML stripped), reply stub, archive. Connection status
checked via `/api/mail/status`.

**Tables**: `mail_tokens` (OAuth credentials), `mail_cache` (optional).

**Known gaps**: Send/reply is stubbed (UI renders but POST not fully wired);
pagination not implemented.

---

### Briefing — `/briefing`

**File**: `src/components/briefing/BriefingModule.tsx`
**Status**: Partial — card grid live, feed discovery newly wired

**Features**: Curated news card grid with category chips (All / Health / Tech /
Finance / Black & Nigerian / …). Reader panel shows expanded story. Save for
later (localStorage, `"axis-briefing-saved"`). "Find Feeds" modal (calls
`/api/briefing/feeds` — Claude Haiku suggests RSS feeds for a query). "Manage
Sources" modal (saved feeds in localStorage, `"axis-briefing-feeds"`).

**API**: `src/app/api/briefing/feeds/route.ts` — POST with `{ query }`, returns
`{ feeds: [{name, url, description}] }`.

**Known gaps**: Stories are static (`STORIES` array); no live RSS fetch. Feed
subscriptions saved in localStorage only, not Supabase. The `/api/briefing`
prefix is auth-guarded in middleware.

---

### Literature — `/literature`

**File**: `src/components/literature/LiteratureModule.tsx`
**Status**: Partial — UI live, API open/public

**Features**: PubMed-style article browser. Topic filter chips (Neurosurgery,
Neuroscience, DBS, AI/Medicine, etc.). Article list with save-for-offline
(localStorage, `"axis-lit-saved"`). Open articles via `useWebViewer`. Calls
`/api/literature` which is in `PUBLIC_API_PREFIXES` (no auth required).

**Hook**: `src/lib/hooks/useLiterature.ts`

**Known gaps**: Article fetch is stub/mock; PubMed E-utilities not yet integrated.

---

### Gallery — `/gallery`

**File**: `src/components/gallery/GalleryModule.tsx`
**Status**: Partial — MET + AIC live, poem stub

**Features**: Rotating artwork browser pulling from the Metropolitan Museum of
Art API and the Art Institute of Chicago API (both public, no key). Poem reader
(stubbed). Masonry grid. Open artwork detail overlay. `/api/gallery` is in
`PUBLIC_API_PREFIXES`.

**Known gaps**: Poem data is hardcoded. No Rijksmuseum (removed in commit
`1409bbe`).

---

### Pipeline — `/pipeline`

**File**: `src/components/pipeline/PipelineModule.tsx`
**Status**: Live (Supabase-backed)

**Features**: Kanban-style research project tracker. Columns: `idea`, `active`,
`submitted`, `published`. Studies with stage, role, collaborators. Conference
tracker (AANS, CNS, etc.) with status labels. Add/edit/delete studies and
conferences.

**Hook**: `src/lib/hooks/usePipeline.ts`

**Tables**: `studies`, `conferences` — both scoped by `user_id`.

---

### Objectives — `/objectives`

**File**: `src/components/objectives/ObjectivesModule.tsx`
**Status**: Live (Supabase-backed)

**Features**: OKR tracker with key results and progress. Habit tracker with
heat-map calendar (GitHub contribution style). Streak calculation. "Scan for
Goals" uses `/api/ai` to extract objectives from Pipeline + Notes context.
Signed-out demo mode shows curated dummy data.

**Hook**: `src/lib/hooks/useObjectives.ts`

**Tables**: `objectives`, `key_results`, `habit_logs`.

---

### People — `/people`

**File**: `src/components/people/PeopleModule.tsx`
**Status**: Live (Supabase-backed)

**Features**: Contact CRM. Tags: Mentor / Collaborator / Friend. Follow-up
reminder. Notes per person. Last interaction date. Signed-out demo mode.

**Hook**: `src/lib/hooks/usePeople.ts`

**Table**: `people` — columns: `id`, `user_id`, `name`, `role`, `tag`, `note`,
`last_contact`, `avatar`.

---

### Fund — `/fund`

**File**: `src/components/fund/FundModule.tsx`
**Status**: Live (mixed — some data live, some stubbed)

**Features**: Portfolio holdings table with P&L (`src/lib/store/fund-defaults.ts`
provides seed defaults). Watchlist tiles with live quotes from Polygon via
`/api/massive/quote`. Allocation bar chart. Cash account via Plaid
(`/api/plaid/status`, `/api/plaid/link`). Bank account balances. Order ticket
modal (`FundOrderTicket.tsx`). Budget tab (`FundBudget.tsx`). Transaction history
(`FundTransactions.tsx`). Research extras panel (`FundResearchExtras.tsx`) for
market news / macro signals.

**API**: `src/lib/massive/client.ts` wraps `api.polygon.io`. Key: `POLYGON_API_KEY`.

**Known gaps**: Brokerage (`/api/brokerage`) is wired for Public.com
(`APP_PUBLIC_API_KEY`) but order execution is not live. Holdings are localStorage-
backed defaults, not a real brokerage feed.

---

### Vitality — `/vitality`

**File**: `src/components/vitality/VitalityModule.tsx`
**Status**: Live (mixed — Strava live, nutrition/meditation stubs)

**Features**: Six tabs: Health, Nutrition, Meditation, Running, Strength &
Conditioning, Yoga & Pilates. Strava activity feed via `useStrava` hook (calls
`/api/strava/route.ts`). Training week planner (`useTrainingWeek`). Workout
detail modal (`WorkoutDetailModal.tsx`). AI regimen generator (`AIRegimenModal.tsx`,
calls `/api/ai` with `action: "regimen"`). Meditation timer (browser-side).

**Hooks**: `src/lib/hooks/useStrava.ts`, `src/lib/hooks/useTrainingWeek.ts`

**Known gaps**: Nutrition tab is static. Yoga / Strength tabs have placeholder
content.

---

### Supper Club — `/supper-club`

**File**: `src/components/supper-club/SupperClubModule.tsx`
**Status**: Stub — UI complete, data hardcoded

**Features**: Recipe browser with diet filter chips (High-Protein, Mediterranean,
Low-Carb, Plant-Forward, Endurance Fuel, West African). Recipe cards with macros.
Shopping list. Meal plan grid (static). No backend; all data in the component file.

**Known gaps**: No Supabase persistence; no recipe generation API. Entirely
stubbed.

---

### Library — `/library`

**File**: `src/components/library/LibraryModule.tsx`
**Status**: Stub

**Features**: File-organiser UI with collection sidebar (All Files, Manuscripts,
IRB & Regulatory, Figures & Images, Lectures & Video). No real file storage
integrated; collection counts are hardcoded.

**Known gaps**: Supabase Storage or Google Drive integration not wired.

---

### Atelier — `/atelier`

**File**: `src/components/atelier/AtelierModule.tsx`
**Status**: Stub (Interface Studio drawer is live)

**Features**: Creative workspace placeholder. The Interface Studio theme drawer
(`src/components/theme/InterfaceStudioDrawer.tsx`) is the main live sub-feature
here — it exposes accent colour presets, font overrides, and custom CSS.

---

### Debrief — `/debrief`

**File**: `src/components/debrief/DebriefModule.tsx`
**Status**: Live (lightweight)

**Features**: Weekly review workflow. Pulls open tasks from `useTasks` and
pending notes from `useNotes`. Stores debrief notes in a special
`"Debrief"` folder. Configurable reminder day/hour (localStorage,
`"debrief-reminder"`).

---

### Listening Vault — `/listening-vault`

**File**: `src/components/vault/VaultModule.tsx`
**Status**: Live (Spotify-backed when connected)

**Features**: Spotify embed player (playlist / album / track / artist). Converts
`open.spotify.com` share URLs to embed URLs. Add custom Spotify URLs. Spotify
playback controlled via `SpotifyProvider` (connect → `/api/spotify/auth`).

---

### Control Room — `/control-room`

**File**: `src/components/control-room/ControlRoomModule.tsx`
**Status**: Live

**Features**: Six tabs — Overview, Connections, Data & Privacy, Appearance,
Security, Activity. Connections tab shows live status for: Spotify, Plaid,
Google Calendar, Outlook Calendar, Gmail, Outlook Mail, Strava. Appearance tab
has theme switcher (dark / dim / slate / light) and Interface Studio link.
Security tab exposes TOTP 2FA setup (`MFASetup.tsx`) and passkey management
(via `usePasskey` hook). Data tab has export / account deletion CTA.

---

## Authentication & Security

### Layer Stack

1. **Supabase Auth** — email/password, magic link, and session cookies via
   `@supabase/ssr`. SSR client: `src/lib/supabase/server.ts`. Browser client:
   `src/lib/supabase/client.ts`.

2. **Passkeys (WebAuthn)** — registration at `/api/auth/passkey/register`,
   authentication at `/api/auth/passkey/authenticate`. Uses
   `@simplewebauthn/server` + `@simplewebauthn/browser`. BiometricGate component
   at `src/components/auth/BiometricGate.tsx` wraps protected views.

3. **TOTP 2FA** — setup via `src/components/auth/MFASetup.tsx`, challenge via
   `src/components/auth/MFAChallenge.tsx`. Supabase MFA API.

4. **Middleware** (`src/middleware.ts`) — intercepts all non-static routes.
   Skips auth for `PUBLIC_API_PREFIXES` (widget routes, literature, gallery,
   OAuth callbacks). Returns `401` for `GUARDED_PREFIXES` without a session
   (financial, AI, profile, calendar, mail, briefing routes). Redirects
   unauthenticated page requests to `/login?redirect=<path>`.

5. **Rate limiting** — Upstash Redis via `@upstash/ratelimit`. Applied to
   `/api/ai` and `/api/signals-ai`. Env: `UPSTASH_REDIS_REST_URL` +
   `UPSTASH_REDIS_REST_TOKEN`.

6. **Row-Level Security** — all user tables in Supabase have RLS enabled with
   `user_id = auth.uid()` policies.

---

## Integrations

| Integration | Direction | Auth | Routes / Notes |
|-------------|-----------|------|----------------|
| **Spotify** | Read + playback | OAuth2 (PKCE) | `/api/spotify/auth`, `/api/spotify/callback`, `/api/spotify/playback`, `/api/spotify/focus`, `/api/spotify/search`, `/api/spotify/library`, `/api/spotify/playlist`, `/api/spotify/disconnect` |
| **Strava** | Read activities | OAuth2 | `/api/strava/route.ts` (`useStrava` hook), env: `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` |
| **Google Calendar** | Read + write events | OAuth2 | `/api/calendar/connect`, `/api/calendar/callback`, `/api/calendar/sync`, `/api/calendar/event`, `/api/calendar/disconnect`, `/api/calendar/status` |
| **Outlook Calendar** | Read + write events | OAuth2 (MSAL) | Shares `/api/calendar/*` routes with `source=outlook` param |
| **Gmail** | Read + archive | OAuth2 | `/api/mail/connect`, `/api/mail/callback`, `/api/mail/inbox`, `/api/mail/message`, `/api/mail/status`, `/api/mail/disconnect` |
| **Outlook Mail** | Read | OAuth2 | Shares `/api/mail/*` routes |
| **Plaid** | Bank balances | Plaid Link | `/api/plaid/link`, `/api/plaid/balances`, `/api/plaid/status` |
| **Polygon.io** | Market data (quotes, history) | API key | `src/lib/massive/client.ts`, env: `POLYGON_API_KEY`. Route prefix `/api/massive/*` |
| **Public.com (Brokerage)** | Portfolio / orders | API key | `/api/brokerage/*`, env: `APP_PUBLIC_API_KEY` / `APP_PUBLIC_ACCOUNT_ID` |
| **MET Museum API** | Artwork | Public (no key) | Called from `/api/gallery` |
| **Art Institute of Chicago** | Artwork | Public (no key) | Called from `/api/gallery` |
| **PubMed (stub)** | Articles | Public (E-utilities) | Called from `/api/literature` — not fully wired |
| **Anthropic (Claude)** | AI generation | API key | `@anthropic-ai/sdk`, env: `ANTHROPIC_API_KEY`. Used in `/api/ai`, `/api/signals-ai`, `/api/briefing/feeds` |

---

## Infrastructure

| Layer | Service | Notes |
|-------|---------|-------|
| **Database + Auth + Storage** | Supabase | Project env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Hosting + Edge** | Vercel | Auto-deploy on push to `main` through the Vercel Git integration |
| **Cache / Rate limiting** | Upstash Redis | `@upstash/ratelimit` + `@upstash/redis`. Env: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| **Framework** | Next.js 15 (App Router) | TypeScript, Tailwind CSS v4, `next-pwa` |
| **Rich text** | TipTap | Used in Notes module |
| **DnD** | `@dnd-kit` | Used in Agenda, Notes, Sidebar |
| **WebAuthn** | `@simplewebauthn/server` + `@simplewebauthn/browser` | Passkey registration + login |

### Supabase Tables (known)

| Table | Module(s) |
|-------|-----------|
| `profiles` | Sidebar profile, avatar, display name, role |
| `tasks` | Agenda, Dispatch (triage → task) |
| `notes` | Notes, Debrief |
| `schedule_events` | Schedule, Console widget |
| `signals` | Dispatch / Signals |
| `objectives` | Objectives |
| `key_results` | Objectives |
| `habit_logs` | Objectives |
| `studies` | Pipeline |
| `conferences` | Pipeline |
| `people` | People |
| `mail_tokens` | Mail (OAuth refresh tokens) |
| `passkey_credentials` | Auth — stored WebAuthn credentials |

---

## API Conventions

### Route Structure

```
src/app/api/
├── ai/              # Axiom context cards, triage, regimen
├── auth/            # Passkey, MFA, settings, account
├── briefing/        # feeds/route.ts — Claude-powered RSS discovery
├── brokerage/       # Public.com portfolio
├── calendar/        # Google + Outlook calendar sync
├── cron/            # CRON_SECRET bearer-auth only, no user session
├── gallery/         # MET + AIC artwork (public, no auth)
├── health/          # App health check
├── literature/      # PubMed articles (public, no auth)
├── mail/            # Gmail + Outlook mail
├── massive/         # Polygon.io market data
├── plaid/           # Plaid banking
├── profile/         # Avatar upload, profile update
├── signals-ai/      # Signal classification (Claude Haiku)
├── spotify/         # Playback, library, search
├── strava/          # Activity feed
└── widgets/         # Public read-only widgets (markets, etc.)
```

### Auth Pattern (guarded route)

```typescript
// Every guarded route starts with this guard:
const supabase = await createClient();  // src/lib/supabase/server.ts
const { data: { user } } = await supabase.auth.getUser();
if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
```

### Rate Limiting Pattern (AI routes)

```typescript
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(20, "1 m"),
});
const { success } = await ratelimit.limit(user.id);
if (!success) return NextResponse.json({ error: "Rate limited" }, { status: 429 });
```

### Public vs. Guarded API Prefixes

Defined in `src/middleware.ts`:

- **`PUBLIC_API_PREFIXES`** (skip auth entirely): `/api/widgets/`, `/api/literature`,
  `/api/gallery`, `/api/auth/forgot-password`, `/api/auth/passkey/authenticate`,
  `/api/calendar/callback`, `/api/mail/callback`

- **`GUARDED_PREFIXES`** (return 401 if no session): `/api/massive`, `/api/plaid`,
  `/api/brokerage`, `/api/ai`, `/api/signals-ai`, `/api/strava`, `/api/profile`,
  `/api/auth/passkey/register`, `/api/auth/passkey/token`, `/api/auth/passkey/list`,
  `/api/auth/passkey/delete`, `/api/auth/settings`, `/api/auth/mfa`,
  `/api/auth/account`, `/api/calendar`, `/api/mail`, `/api/briefing`

---

## Known Gaps & Roadmap

### High Priority

| Gap | Location | Notes |
|-----|----------|-------|
| Briefing stories are static | `src/components/briefing/BriefingModule.tsx` | No live RSS fetch; `STORIES` array is hardcoded |
| Mail send/reply stub | `src/components/mail/MailModule.tsx` | POST endpoint wiring incomplete |
| Schedule Month/Day live data | `src/components/schedule/ScheduleModule.tsx` | Month and Day views render stub arrays |
| Fund holdings → real brokerage | `src/components/fund/FundModule.tsx` | `DEFAULT_HOLDINGS` from `fund-defaults.ts`, not live portfolio API |

### Medium Priority

| Gap | Location | Notes |
|-----|----------|-------|
| Literature → PubMed E-utilities | `src/app/api/literature/` | API not wired; returns stubs |
| Supper Club → Supabase persistence | `src/components/supper-club/SupperClubModule.tsx` | Entirely in-memory |
| Library → file storage | `src/components/library/LibraryModule.tsx` | No Supabase Storage integration |
| Briefing feeds → Supabase | `src/components/briefing/BriefingModule.tsx` | `savedFeeds` lives in localStorage only |

### Low Priority / Cosmetic

| Gap | Location | Notes |
|-----|----------|-------|
| Atelier module content | `src/components/atelier/AtelierModule.tsx` | Mostly empty stub |
| Vitality nutrition + yoga tabs | `src/components/vitality/VitalityModule.tsx` | Static placeholder content |
| Console tidbit counts | `src/components/console/ConsoleModule.tsx` | Task/mail counts are partly hardcoded |
| New Board feature | `src/components/nav/Sidebar.tsx` | Toast fires "coming soon" |

---

## Navigation Structure

Defined in `src/lib/store/nav.ts` as `DEFAULT_NAV`. Fully user-rearrangeable
(drag-and-drop, rename) with state persisted to localStorage keys:
`axis-nav-order`, `axis-nav-group-order`, `axis-nav-labels`, `axis-nav-group-labels`.

```
Daily:   Command (/command), Dispatch (/dispatch), Schedule (/schedule),
         Agenda (/agenda), Mail (/mail), Notes (/notes)
Plan:    Objectives (/objectives), Debrief (/debrief)
Research: Pipeline (/pipeline), Literature (/literature)
Life:    Vitality (/vitality), Atelier (/atelier), Gallery (/gallery),
         People (/people), Briefing (/briefing), Listening Vault (/listening-vault),
         Library (/library), Supper Club (/supper-club)
Capital: Fund (/fund)
System:  Control Room (/control-room)
Apps:    Step 2 CK Bank (static), + user-added URL modules
```
