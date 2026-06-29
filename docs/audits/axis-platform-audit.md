# AXIS Platform Audit

> Product · UX · Architecture · Integration · Latency review
> Scope: `README.md`, `package.json`, `next.config.ts`, `vercel.json`, `.github/workflows`, `src/app`, `src/components`, `src/lib`, `src/lib/store`, `src/lib/hooks`, `src/app/api`, `supabase/migrations`
> Method: static read-only inspection of the repository at branch `main` (commit `176bd85`). **No code was changed.**
> Date: 2026-06-27

---

## 0. Executive summary

AXIS is far more mature than its `README.md` implies. What the README calls "static prototypes" (Mail, People, Briefing, Objectives, Pipeline, Literature, Atelier) are now real, Supabase-backed, full-CRUD modules with realtime refresh. The platform spans **~25 page routes, ~30 module components, ~90 API routes, and ~50 Supabase tables**, with a genuinely good provider-abstraction layer (Composio + direct-OAuth adapters), a two-provider AI router (Gemini Flash → Claude Haiku) with heuristic fallbacks, SSRF-guarded proxies, RLS on every table, and a working cross-module routing spine (Dispatch → Tasks/People/Notes/Literature).

The weaknesses are not "fake UI" — they are **integration dead-ends, latency hot spots, and hygiene debt** that will bite in production:

- **Health integrations are a dead-end** — connect routes redirect to OAuth providers that have no callback handler, no token table, and no env keys. The UI shows "coming soon." (I1, P1)
- **Two cron routes are orphaned** — `feed-digest` and `intelligence-sweep` exist but are scheduled by neither `vercel.json` nor GitHub Actions. (I2, P1)
- **Legacy direct-OAuth mail/calendar read paths survive without a way to create connections** — the connect routes were deleted but `mail_connections`/`calendar_connections` are still read. (I3, P2)
- **Console + Mail do live third-party fan-out on first paint** — N client→server→external round-trips, no Supabase cache-first layer. (L1, L2)
- **Several hooks silently fall back to `localStorage`** when a table "looks missing," so data quietly stops syncing across devices. (A3, P2)
- **Migration hygiene is broken** — duplicate numeric prefixes (`020_`, `036_`), a gap (`025`), and ~15 unnumbered files make `supabase db push` ordering nondeterministic. (A4, P1)
- **Supabase clients are untyped** (no `Database` generic) and the one hand-written type file is orphaned and stale (references a dropped table). (A5, P2)
- **No automated tests exist** at all. (A7, P2)
- **README is materially stale** and undersells the product. (A6, P2)

Detailed findings are tagged `U#` (UX), `A#` (architecture), `L#` (latency), `I#` (integration) and prioritized in §6.

---

## 1. Current platform map

### 1.1 Page routes → module → status

Legend — **Complete**: full create/read/update/delete + persistence + states. **Partial**: works but missing actions, states, or persistence. **Static**: renders from hardcoded/localStorage data, no server persistence. **Broken**: a primary path dead-ends.

| Route | Module component | Status | Data sources | External APIs | Supabase tables | Cross-module deps |
|---|---|---|---|---|---|---|
| `/` | `app/page.tsx` (landing/redirect) | Complete | Supabase auth | — | `auth.users` | Redirects signed-in → `/command` |
| `/login` | `app/login/page.tsx` | Complete | Supabase auth, passkeys, MFA | WebAuthn | `user_passkeys`, `user_auth_settings`, `webauthn_challenges` | — |
| `/command` | `ConsoleModule` | Complete | `useWidgetData`, capture→Signals, photos | Open-Meteo, Polygon, art/gallery | `console_widgets`, `console_photos`, `signals` | Capture → Signals; agenda widget → Tasks |
| `/console` | `ConsoleModule` | **Duplicate** of `/command` | same | same | same | **Nav-orphan** (not in nav/palette) |
| `/dispatch` | `SignalsModule` | Complete | `useSignals`, `useSignalRoutes`, `useTasks`, `usePeople`, `useNotes` | `/api/signals-ai`, `/api/ai` | `signals`, `signal_routes`, `tasks`, `people`, `notes` | **Routing spine** → Tasks/People/Notes/Literature |
| `/signals` | `SignalsModule` | **Duplicate** of `/dispatch` | same | same | same | **Nav-orphan** |
| `/schedule` | `ScheduleModule` | Complete | direct Supabase, calendar adapters | Composio (Google/Outlook Cal), direct OAuth | `schedule_events`, `calendar_connections`, `composio_connections` | Vitality push (stub), conflicts |
| `/agenda` | `AgendaModule` | Complete | `useTasks`, `usePeople` | `/api/ai` (rebuild), `/api/agenda/rebuild` | `tasks`, `people`, `user_preferences` | People follow-ups, morning routine |
| `/mail` | `MailModule` | Complete | `/api/mail/*` | Composio (Gmail/Outlook) + direct OAuth | `composio_connections`, `mail_connections` | Compose, message detail panel |
| `/notes` | `NotesModule` + `NotesEditor` (TipTap) | Complete | `useNotes` | `/api/ai`, `/api/embeddings`, `/api/notes/*` | `notes`, `note_embeddings`, `note_artifacts` | Semantic search, Debrief, transcription |
| `/objectives` | `ObjectivesModule` | Complete | `useObjectives` | `/api/objectives/scan`, `/api/ai` | `objectives`, `key_results` | Platform-scan from other modules |
| `/debrief` | `DebriefModule` | **Partial** | `useNotes`, `useTasks` | `/api/ai` | `notes`, `tasks` | Writes reflection → Notes; reminder = localStorage only |
| `/pipeline` | `PipelineModule` | Complete | `usePipeline` | `/api/ai` (draft) | `studies`, `pipeline_stages`, `conferences`, `board_fields` | Research/Literature |
| `/literature` | `LiteratureModule` | Complete (w/ caveat) | `useLiterature` | `/api/literature`, `/api/ai`, source feeds | `literature_prefs`, `literature_saved` | localStorage fallback path (A3) |
| `/vitality` | `VitalityModule` | **Partial** | `useVitalityLogs`, `useFitnessRoutines`, `useNutritionProtocol`, `useTrainingWeek`, `useStrava` | Strava (MCP/`/api/strava`), Open-Meteo | `training_sessions`, `fitness_routines(+_exercises)`, `nutrition_protocol`, `meal_logs`, `meditation_sessions`, `habits(+_checks)`, `user_strava_tokens` | Health devices = stub; video cards hardcoded |
| `/atelier` | `AtelierModule` | Complete | `useAtelierPrefs`, gallery | `/api/gallery`, `/api/og-image` | `atelier_prefs`, `moodboard_images` | WebViewer |
| `/people` | `PeopleModule` + `AddContactsPicker` | Complete | `usePeople` | Composio contacts, `/api/people/match-contacts`, `/api/contacts/list` | `people`, `contacts_connections`, `composio_connections` | Dispatch → People; Agenda follow-ups |
| `/briefing` | `BriefingModule` | Complete | `useBriefing` | `/api/briefing/*`, RSS, `/api/og-image` | `briefing_feeds`, `briefing_saved_items`, `feed_cache` | WebViewer, feed-digest cron (orphaned) |
| `/listening-vault` | `VaultModule` | Complete | `useSpotify`, saved links | Spotify (OAuth) | `user_preferences` (links) | Sidebar miniplayer |
| `/library` | `LibraryModule` | Complete | `useLibraryFiles` | Supabase Storage | `library_files` | Notes/Atelier |
| `/supper-club` | `SupperClubModule` | **Static** | `lib/recipes.ts` const + localStorage | `/api/og-image` | none | WebViewer |
| `/fund` | `OverviewModule` (+ 9 subroutes) | Complete | `/api/fund/*`, `/api/plaid/*`, `/api/brokerage/*`, `/api/massive/*` | Polygon, Plaid, Public.com | `fund_holdings`, `fund_watchlist`, `fund_transactions`, `fund_bank_transactions`, `fund_category_budgets`, `fund_liabilities`, `fund_recurring_transactions`, `fund_connections`, `net_worth_snapshots`, `ai_insights` | Briefing/markets |
| `/control-room` | `ControlRoomModule` | Complete | 19 fetches to integration/auth APIs | all providers | `composio_connections`, `user_auth_settings`, `profiles`, `audit_logs`, `health_check_runs` | Hub for all integrations |
| `/privacy`, `/terms` | static legal pages | Complete | — | — | — | — |
| `/oauth-done` | OAuth popup closer | Complete | — | — | — | Spotify/Composio popups |
| `error.tsx`/`global-error.tsx`/`not-found.tsx` | error boundaries | Complete | Sentry | Sentry | — | — |

**Fund subroutes** (`app/fund/*`, all under `fund/layout.tsx` + `FundSubNav`): `/fund` (overview), `/fund/investing`, `/fund/watchlist`, `/fund/market`, `/fund/spending`, `/fund/cashflow`, `/fund/net-worth`, `/fund/forecasting`, `/fund/advisor`, `/fund/position/[symbol]`. All data-backed; cash-flow/spending depend on Plaid being configured, order-ticket on Public.com being configured (both degrade to "connect/local-log" states).

### 1.2 API route inventory (by domain)

| Domain | Routes | Backed by |
|---|---|---|
| Market data | `/api/massive/{quote,history,search,snapshot,status,movers,news}` | Polygon proxy (`lib/massive/client.ts`) |
| Fund | `/api/fund/{holdings,liabilities,recurring,category-budgets,bank-transactions}[/[id]]`, `/api/fund/{networth,insights,advisor,report,position/[symbol]}` | Supabase + Polygon + AI |
| Banking | `/api/plaid/{link,exchange,balances,transactions,budget,status,webhook}` | Plaid (`lib/fund/plaidTokens.ts`, `syncPlaidTransactions.ts`) |
| Brokerage | `/api/brokerage/{accounts,positions,order,orders,order-history,status}` | Public.com (`_lib.ts`, scaffold) |
| Mail | `/api/mail/{inbox,message/[id],send,status,disconnect}` | Composio + direct (`lib/mail/*`) |
| Calendar | `/api/calendar/{status,external,sync,conflicts,event/[id],disconnect}` | Composio + direct (`lib/calendar/*`) |
| Contacts | `/api/contacts/list`, `/api/people/match-contacts` | Composio (`lib/contacts/*`) |
| Integrations | `/api/integrations/composio/{connect,disconnect,execute,status}` | Composio (`lib/integrations/composio.ts`) |
| Health | `/api/health/{oura,whoop,fitbit,garmin}/connect` | **OAuth init only — no callbacks (I1)** |
| Spotify | `/api/spotify/{auth,callback,token,playback,search,library,focus,playlist/[id],disconnect}` | Spotify direct OAuth (`_lib.ts`) |
| Strava | `/api/strava` | Strava (`_lib.ts`) + MCP |
| AI | `/api/ai`, `/api/ai/status`, `/api/signals-ai`, `/api/embeddings`, `/api/objectives/scan`, `/api/signals/scan` | `lib/ai/router.ts` (Gemini/Anthropic) |
| Widgets | `/api/widgets/{weather,daylight,agenda,air-quality,markets,training,art}` | Open-Meteo, Polygon, gallery |
| Briefing | `/api/briefing/{feeds,fetch-feeds}`, `/api/feeds/cached` | RSS (`lib/feeds/rss.ts`) |
| Search | `/api/search`, `/api/search/quick`, `/api/search/semantic` | Supabase + pgvector |
| Auth | `/api/auth/{account,settings,forgot-password}`, `/api/auth/mfa/{enroll,verify,challenge,unenroll}`, `/api/auth/passkey/{register,authenticate,list,delete,token}` | Supabase + WebAuthn (`lib/webauthn/server.ts`) |
| Cron | `/api/cron/{daily,finance-daily,feed-digest,intelligence-sweep}` | **only 2 scheduled (I2)** |
| Webhooks | `/api/webhooks/make`, `/api/plaid/webhook` | Make (HMAC), Plaid (signed JWT) |
| Misc | `/api/proxy`, `/api/og-image`, `/api/tavily/extract`, `/api/gallery`, `/api/literature`, `/api/notes/{transcribe,youtube}`, `/api/profile/avatar` | SSRF-guarded fetch, external |

### 1.3 Supabase tables (≈50, from `supabase/migrations`)

`profiles`, `user_preferences`, `user_auth_settings`, `user_passkeys`, `webauthn_challenges`, `audit_logs`, `health_check_runs`, `console_widgets`, `console_photos`, `signals`, `signal_routes`, `tasks`, `notes`, `note_embeddings`, `note_artifacts`, `people`, `objectives`, `key_results`, `habits`, `habit_checks`, `studies`, `pipeline_stages`, `conferences`, `board_fields`, `literature_prefs`, `literature_saved`, `schedule_events`, `calendar_connections`, `mail_connections`, `contacts_connections`, `composio_connections`, `briefing_feeds`, `briefing_saved_items`, `feed_cache`, `atelier_prefs`, `moodboard_images`, `library_files`, `fund_holdings`, `fund_watchlist`, `fund_transactions`, `fund_bank_transactions`, `fund_category_budgets`, `fund_liabilities`, `fund_recurring_transactions`, `fund_connections`, `net_worth_snapshots`, `fund_snapshots` (**dropped in `020`, dead**), `training_sessions`, `fitness_routines`, `fitness_routine_exercises`, `nutrition_protocol`, `meal_logs`, `meditation_sessions`, `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_insights`, `user_strava_tokens`.

---

## 2. UX completeness audit

Matrix columns: **Create / List / Detail (click-in) / Edit / Delete-Archive-Complete / Route→other module / States (L=loading E=empty Er=error) / Persists refresh**.
`✓` yes · `~` partial · `✗` no · `n/a` not applicable.

| Module | Create | List | Detail | Edit | Del/Done | Route | States | Persist |
|---|---|---|---|---|---|---|---|---|
| Console | ✓ (capture, widgets, photos) | ✓ | ~ (widgets not clickable to detail) | ✓ (customize) | ✓ (remove widget) | ✓ (capture→Signals) | L✓ E✓ Er✓ | ✓ |
| Dispatch/Signals | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (→Task/Person/Note/Lit) | L✓ E✓ Er✓ | ✓ |
| Schedule | ✓ | ✓ | ✓ | ✓ | ✓ | ~ (Vitality push stub) | L✓ E✓ Er✓ | ✓ |
| Agenda | ✓ | ✓ | ~ | ✓ | ✓ (complete) | ✓ (people/routine) | L✓ E✓ Er✓ | ✓ |
| Mail | ✓ (compose/send) | ✓ | ✓ (panel) | n/a | ~ (no archive/delete) | ~ | L✓ E✓ Er~ (per-account fail silent) | ✓ |
| Notes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (artifacts/search) | L✓ E✓ Er✓ | ✓ |
| Objectives | ✓ | ✓ | ~ | ✓ | ✓ | ✓ (scan) | L✓ E✓ Er✓ | ✓ |
| Pipeline | ✓ | ✓ | ~ | ✓ | ✓ | ~ | L✓ E✓ Er✓ | ✓ |
| Literature | ✓ (topics/saved) | ✓ | ✓ (WebViewer) | ✓ | ✓ | ~ | L✓ E✓ Er✓ | ~ (localStorage fallback A3) |
| Vitality | ✓ (sessions/meals/meditation) | ✓ | ✓ (WorkoutDetailModal) | ✓ | ✓ | ~ | L✓ E✓ Er✓ | ✓ (health devices ✗) |
| Atelier | ✓ (moodboard pins) | ✓ | ~ | ✓ | ✓ | n/a | L✓ E✓ Er✓ | ✓ |
| People | ✓ | ✓ | ✓ (modal) | ✓ | ✓ | ✓ (contacts import) | L✓ E✓ Er✓ | ✓ |
| Briefing | ✓ (feeds/saved) | ✓ | ✓ (WebViewer) | ✓ | ✓ | ~ | L✓ E✓ Er✓ | ✓ |
| Listening Vault | ✓ (saved links) | ✓ | ✓ (embed) | ~ | ✓ | n/a | L✓ E~ Er~ | ✓ |
| Library | ✓ (upload) | ✓ | ✓ (open) | ~ (rename?) | ✓ | n/a | L✓ E✓ Er✓ | ✓ |
| Supper Club | ~ (save only) | ✓ | ✓ (WebViewer) | ✗ | ~ (unsave) | ✗ | L~ E~ Er~ | ✗ (**localStorage only**) |
| Fund | ✓ (holdings/liab/recurring/budgets) | ✓ | ✓ (`/position/[symbol]`) | ✓ | ✓ | ~ | L✓ E✓ Er✓ | ✓ |
| Control Room | ✓ (connect/disconnect) | ✓ | n/a | ✓ (settings) | ✓ | n/a | L✓ E~ Er✓ | ✓ |
| Debrief | ✓ (reflection→Notes) | ~ (past via Notes) | ✗ | ✓ | n/a | ✓ (→Notes) | L~ E~ Er✓ | ~ (reminder localStorage, no delivery) |

### Per-module UX findings

- **U1 — Console widgets are not clickable into detail.** Widgets render a value + hint but tapping a widget does nothing; agenda/markets/run widgets are natural drill-ins (→ `/agenda`, `/fund/market`, `/vitality`). *Severity: P2.*
- **U2 — Mail lacks archive/delete/read-toggle actions.** `MailModule` can list/read/compose/send, but a message detail panel exposes no archive, delete, mark-read, or reply-in-thread persistence; per-account fetch failures are swallowed (`Promise.allSettled` → silently dropped, violating "no silent failures"). *Severity: P1 (silent failure) / P2 (actions).* Files: `src/app/api/mail/inbox/route.ts:33-49`, `src/components/mail/MessagePanel.tsx`.
- **U3 — Supper Club is the only fully static module.** Recipes come from `lib/recipes.ts`; saves live in `localStorage` (`axis-supper-*`). No detail, edit, or routing. Either mark demo-only in UI or back it with a table. *Severity: P3.*
- **U4 — Debrief reminder is cosmetic.** Day/hour reminder is written to `localStorage` (`REMINDER_KEY`) with **no scheduler/notification delivery** and no cross-device persistence. The reflection itself does persist (→ Notes). *Severity: P2.* Files: `src/components/debrief/DebriefModule.tsx:218,292`.
- **U5 — Vitality "Live Metrics" + connect promise data that never arrives.** Health-device connect surfaces "OAuth setup required — coming soon"; metric grid stays empty. Follow-along video cards are hardcoded curated lists (documented as such at `VitalityModule.tsx:159-167`). *Severity: P2 (sets false expectation).* See I1.
- **U6 — Detail/drill-in is shallow in Objectives, Pipeline, Agenda, Atelier.** Items are editable inline but don't open a focused detail view with history/related items, which is the stated "Definition of Done" (list items open into usable detail views). *Severity: P3.*

---

## 3. Architecture audit

### A1 — Overgrown components (god modules)
- **Severity:** P2
- **Current:** Several module components are 700–1,935 LOC and own data-fetching, view logic, modals, and provider glue in one file:
  - `vitality/VitalityModule.tsx` — **1,935**
  - `notes/NotesModule.tsx` — **1,329**
  - `control-room/ControlRoomModule.tsx` — **1,317** (19 inline `fetch` calls)
  - `console/ConsoleModule.tsx` — **1,277**
  - `vault/VaultModule.tsx` — **1,176**
  - `pipeline/PipelineModule.tsx` — **815**, `vitality/WorkoutDetailModal.tsx` — **764**, `schedule/ScheduleModule.tsx` — **728**, `signals/SignalsModule.tsx` — **702**, `mail/MailModule.tsx` — **693**
- **Expected:** Thin module shells composing presentational subcomponents; data/IO in hooks/services (the project already does this well for `usePeople`/`useTasks`/etc.).
- **Root cause:** Modules accreted features without extraction; Control Room never got a per-integration service layer (it calls integration APIs inline).
- **Files:** the above.
- **Proposed fix:** Extract subcomponents (e.g. `Vitality/{TrainingTab,NutritionTab,MeditationTab,DevicesTab}`); move Control Room's 19 fetches into `lib/integrations/*` client services; keep modules < ~300 LOC.
- **Acceptance:** No module file > 500 LOC; Control Room contains no raw `fetch`.

### A2 — API routes that know too much about providers / missing service layer
- **Severity:** P2
- **Current:** Mail/Calendar adapters are well-abstracted (`lib/mail/*`, `lib/calendar/*`), but **route handlers still branch on provider** (`/api/mail/inbox/route.ts` switches `gmail`/`outlook`/`composio`; `/api/calendar/external` imports both `google` and `outlook` adapters and merges inline). Brokerage/Plaid logic lives partly in `_lib.ts` co-located with routes rather than in `lib/`.
- **Expected:** A single `listInbox(userId)` / `listEvents(userId)` service that internally fans out across providers and returns a normalized union, so routes are dumb pass-throughs.
- **Root cause:** Adapters were introduced per-provider; the unifying service (the merge/normalize step) leaked into the route.
- **Files:** `src/app/api/mail/inbox/route.ts`, `src/app/api/calendar/external/route.ts`, `src/app/api/calendar/sync/route.ts`, `src/app/api/brokerage/_lib.ts`, `src/app/api/plaid/_lib.ts`.
- **Proposed fix:** Add `lib/mail/index.ts` (`listAllInbox`, `sendMail`) and `lib/calendar/index.ts` (`listAllEvents`, `createEvent`, `deleteEvent`) that own provider dispatch; move `_lib.ts` into `lib/fund/`.
- **Acceptance:** Mail/calendar routes contain no provider names; provider dispatch is unit-testable in `lib/`.

### A3 — `localStorage` used as a primary/fallback store instead of Supabase
- **Severity:** P2
- **Current:** Four hooks fall back to `localStorage` when the table "looks missing," and others keep legacy localStorage paths:
  - `useLiterature.ts` — topic selection + custom topics persist to `localStorage`; `prefsTable` ref flips false and **degrades silently** (`:90,116`).
  - `useTrainingWeek.ts`, `useNutritionProtocol.ts`, `useFitnessRoutines.ts` — write to `localStorage` when DB error/"table missing," seeded demo buckets for signed-out users.
  - `useBriefing.ts`, `useAtelierPrefs.ts`, `useVitalityLogs.ts` — legacy `localStorage` keys (one-time import — acceptable).
  - `DebriefModule.tsx` reminder (U4).
- **Expected:** Migrations are applied → Supabase is authoritative; signed-in users never silently lose cross-device sync.
- **Root cause:** Defensive "works before migration" code that is now dead-or-dangerous because the tables **do exist** (`literature_prefs.sql`, `fitness_routines.sql`, `nutrition_protocol.sql`) — but the unnumbered migration files (A4) may never have been pushed, so the fallback can silently activate in prod.
- **Files:** `src/lib/hooks/useLiterature.ts`, `useTrainingWeek.ts`, `useNutritionProtocol.ts`, `useFitnessRoutines.ts`.
- **Proposed fix:** Confirm tables are deployed, then remove the silent-degrade paths (or surface a visible "offline / not synced" badge instead of silent localStorage). Keep only signed-out demo seeding.
- **Acceptance:** Signed-in writes always hit Supabase or show an explicit error; no silent localStorage substitution.

### A4 — Migration ordering is nondeterministic
- **Severity:** P1 (data-integrity / deploy risk)
- **Current:** `supabase/migrations` mixes numbered and unnumbered files and has collisions:
  - **Duplicate prefixes:** two `020_` (`020_drop_fund_snapshots.sql`, `020_task_completed_at.sql`), two `036_` (`036_fund_spending.sql`, `036_profiles_ai_provider_default_gemini.sql`).
  - **Gap:** no `025_`.
  - **~15 unnumbered files:** `atelier_prefs.sql`, `briefing_tables.sql`, `feed_cache.sql`, `fitness_routines.sql`, `nutrition_protocol.sql`, `moodboard_images.sql`, `library_files.sql`, `vitality_logs.sql`, `pipeline_dates.sql`, `literature_watch_tracking.sql`, `relocate_vector_trgm_extensions.sql`, `fund_connections_plaid_token_columns.sql`, etc.
- **Expected:** Strictly ordered, uniquely-prefixed migrations so `supabase db push` (which sorts by filename) replays deterministically on a fresh DB.
- **Root cause:** Migrations authored ad hoc, some via MCP/dashboard without the CLI naming convention.
- **Files:** entire `supabase/migrations/`.
- **Proposed fix:** Renumber to a monotonic sequence (or timestamped CLI format), fold unnumbered files into the sequence, and verify a clean replay against an empty project. Track applied set with `mcp__supabase__list_migrations`.
- **Acceptance:** `supabase db reset` on a fresh project applies cleanly end-to-end; numbers are unique and gapless.

### A5 — Supabase clients are untyped; `types/database.ts` is orphaned + stale
- **Severity:** P2
- **Current:** `createClient()` (client/server) is instantiated **without a `Database` generic**, so every `.from().select()` returns `any`. `src/lib/types/database.ts` (109 LOC, hand-written) is **imported nowhere** and still declares `FundSnapshot` — a table dropped in `020_drop_fund_snapshots.sql`.
- **Expected:** Generated types wired into the client generic for end-to-end type safety.
- **Root cause:** Types were stubbed by hand and never regenerated/wired after the schema grew.
- **Files:** `src/lib/supabase/{client,server,admin}.ts`, `src/lib/types/database.ts`.
- **Proposed fix:** Generate types (`mcp__supabase__generate_typescript_types`) into `src/lib/types/database.ts`, parameterize `createClient<Database>()`, delete dead interfaces.
- **Acceptance:** Queries are typed; `tsc` flags column typos; no references to dropped tables.

### A6 — README and docs are materially stale
- **Severity:** P2
- **Current:** `README.md` lists only `/console /fund /schedule /login` routes and labels Mail/People/Library/Objectives/Pipeline/Literature/Briefing/Atelier/Supper Club/Debrief as "static prototypes, no persistence." All but Supper Club are now real, persisted modules. The route table, "What's implemented vs stubbed," and project structure are all out of date. `docs/` contains only `DESIGN_HANDOFF.md`.
- **Expected:** Docs reflect the ~25-route, Composio-backed reality, including the integration architecture and cron/webhook setup.
- **Root cause:** Rapid feature growth outpaced docs.
- **Files:** `README.md`, `docs/`.
- **Proposed fix:** Rewrite README route/status tables; add `docs/architecture.md` (provider-adapter pattern, AI router, cron/webhook map) and `docs/integrations.md`.
- **Acceptance:** Every nav route and every env var appears in README; no module mislabeled.

### A7 — No automated tests
- **Severity:** P2
- **Current:** No `test` script in `package.json`, no test runner dependency, zero `*.test.*`/`*.spec.*` files. The only safety net is the GitHub Actions `tsc --noEmit` + `npm audit` daily job.
- **Expected:** At least unit coverage on pure logic (`lib/ai/router.ts` routing, `usePeople.normalizeName`, `lib/security/ssrf.ts`, provider normalizers in `lib/mail/composio.ts`).
- **Root cause:** Not prioritized.
- **Proposed fix:** Add Vitest; cover the provider normalizers (highest-risk, defensively-mapped code) and SSRF guard first.
- **Acceptance:** `npm test` runs in CI; normalizers + SSRF guard covered.

### A8 — Duplicate / orphaned routes
- **Severity:** P3
- **Current:** `/console` duplicates `/command`; `/signals` duplicates `/dispatch`. Neither duplicate appears in `lib/store/nav.ts` or the command palette — they're reachable only by direct URL.
- **Expected:** One canonical route each; legacy URLs redirect.
- **Files:** `src/app/console/page.tsx`, `src/app/signals/page.tsx`.
- **Proposed fix:** Replace duplicates with `redirect("/command")` / `redirect("/dispatch")`.
- **Acceptance:** No two routes render the same module independently.

---

## 4. Latency audit

### L1 — Console does N live third-party fetches on first paint
- **Severity:** P1
- **Current:** `useWidgetData` fires **one client→server fetch per widget** (`weather, daylight, agenda, air, markets, run`), each hitting an external API server-side (Open-Meteo, Polygon, etc.). No Supabase cache. First paint shows "…" placeholders until all round-trips resolve; refresh re-runs every 15 min. Location-dependent widgets refetch a second time once GPS resolves (`geoVersion` bump).
- **Expected:** Cache-first: read last-known widget values from Supabase instantly, then revalidate in the background (SWR pattern); ideally one batched endpoint.
- **Root cause:** Per-widget fetcher map with no persistence layer.
- **Files:** `src/lib/hooks/useWidgetData.ts`, `src/app/api/widgets/*`.
- **Proposed fix:** Add a `widget_cache` table (or reuse `feed_cache` pattern), serve cached values immediately, revalidate server-side; collapse to `/api/widgets/batch?ids=`.
- **Acceptance:** Console renders real (cached) values < 200 ms with no network; external calls happen off the critical path.

### L2 — Mail inbox blocks on live provider fan-out every load
- **Severity:** P1
- **Current:** `/api/mail/inbox` calls every connected account's provider live on each request (`listGmailInbox`/`listOutlookInbox`/`listComposioInbox`), merges, sorts. No cached inbox table. With 3 accounts that's 3 serial provider auth + list round-trips before any mail renders, and failed accounts are silently dropped (U2).
- **Expected:** Persist a synced inbox (cache table or periodic sync), serve cached on load, refresh in background; surface per-account errors.
- **Root cause:** No mail sync/cache layer; read path = live provider call.
- **Files:** `src/app/api/mail/inbox/route.ts`, `src/lib/mail/*`.
- **Proposed fix:** Add `mail_messages` cache + a sync job (cron or on-demand), serve from cache, return per-account `{account, ok, error}` status.
- **Acceptance:** Mail renders cached < 300 ms; provider failures visible per account.

### L3 — N+1 / per-row patterns in finance + fund pages
- **Severity:** P2
- **Current:** Fund subpages each fetch independently (`/api/fund/holdings`, `/networth`, `/insights`, `/api/massive/*`), and per-position pages call `/api/fund/position/[symbol]` + a Polygon quote. Spending/cashflow call Plaid live. Multiple fund pages re-fetch overlapping holdings data rather than sharing a cached store.
- **Expected:** Shared client cache (one holdings/quotes fetch hydrating all fund subpages); quotes batched via the existing snapshot endpoint.
- **Root cause:** No shared fund data store (unlike `usePeople`/`useTasks` hooks); each subpage is self-contained.
- **Files:** `src/components/fund/*`, `src/app/api/fund/*`.
- **Proposed fix:** Introduce `useFund()` (holdings/watchlist/quotes) shared across subroutes; batch quotes through `/api/massive/snapshot`.
- **Acceptance:** Navigating Fund subroutes triggers no duplicate holdings/quote fetches within a session.

### L4 — Pagination exists for mail only; other lists are unbounded
- **Severity:** P2
- **Current:** `/api/mail/inbox` supports `pageToken`/`skip`. Tasks, signals, notes, people, transactions, etc. `select("*")` with `.order()` and **no `.limit()`/cursor**. Fine at personal scale today; degrades as `notes`/`tasks`/`fund_bank_transactions` grow.
- **Expected:** Cursor/limit on high-volume lists (transactions, notes, signals).
- **Files:** `src/lib/hooks/{useTasks,useSignals,useNotes}.ts`, `src/app/api/fund/bank-transactions/route.ts`.
- **Proposed fix:** Add `.limit()` + range cursors; virtualize long lists client-side.
- **Acceptance:** No list query returns unbounded rows; transactions paginate.

### L5 — Heavy client bundles from large single-file modules + TipTap
- **Severity:** P3
- **Current:** 1,000–1,900-LOC client modules (A1) plus the full TipTap stack (10 extensions) ship to the client. No evident route-level code-splitting beyond Next defaults.
- **Expected:** Lazy-load TipTap/editor and heavy modals; split god components.
- **Files:** `notes/NotesEditor.tsx`, `vitality/*`.
- **Proposed fix:** `next/dynamic` for the editor and detail modals; extract per A1.
- **Acceptance:** Notes route JS payload drops measurably (Lighthouse TBT improves).

---

## 5. Integration audit

### Direct-OAuth vs Composio (current reality)
- **Composio-backed:** Mail (Gmail/Outlook), Calendar (Google/Outlook), Contacts. Central client in `lib/integrations/composio.ts`; per-domain adapters in `lib/{mail,calendar,contacts}/composio.ts`; connect/disconnect/status/execute under `/api/integrations/composio/*`. Connections persisted in `composio_connections`. **This is the strongest part of the architecture.**
- **Direct OAuth (kept intentionally):** Spotify (`/api/spotify/*`), Strava (`/api/strava` + MCP + `user_strava_tokens`), Plaid, Public.com brokerage, Polygon (server key). Consistent with the OAuth-consolidation decision (Spotify/Strava/health stay direct).
- **AI:** Two-provider router (`lib/ai/router.ts`) — Gemini Flash via REST, Claude Haiku via SDK, cost-routed with per-mode eligibility, user override via `profiles.ai_provider`, embeddings pinned to Gemini. Heuristic fallbacks everywhere (`/api/ai`). Well-built.

### I1 — Health integrations dead-end (connect → nowhere)
- **Severity:** P1
- **Current:** `/api/health/{oura,whoop,fitbit,garmin}/connect` build a provider OAuth redirect to `/api/health/<p>/callback`, **but no callback routes exist**, there is **no health-token table** (only `user_strava_tokens`), and **no env client IDs** are set (routes return `501` "requires `<P>_CLIENT_ID`"). The Vitality UI calls connect, gets 501, and shows "OAuth setup required — coming soon." So "Live Metrics" can never populate.
- **Expected:** Either (a) complete the loop — callback routes, encrypted token storage, a `health_connections` table, and a sync that fills metrics; or (b) explicitly mark devices "planned" and hide the connect affordance.
- **Root cause:** Connect routes scaffolded before callbacks/storage/keys.
- **Files:** `src/app/api/health/*/connect/route.ts`, `src/components/vitality/VitalityModule.tsx:977-992`.
- **Proposed fix:** If pursuing: add `lib/health/<provider>.ts` adapters + `/callback` routes + `health_connections` (mirror `mail_connections`) + a metrics sync (cron). If deferring: gate the UI behind a "Planned" state, no live 501 call.
- **Acceptance:** A user can connect at least one device end-to-end and see metrics persist across refresh — OR the UI makes the unbuilt state unambiguous.

### I2 — Orphaned cron routes (no scheduler)
- **Severity:** P1
- **Current:** `/api/cron/daily` (Vercel cron `0 6 * * *` + GitHub Actions `0 7 * * *`) and `/api/cron/finance-daily` (`0 22 * * *`) are scheduled. **`/api/cron/feed-digest` and `/api/cron/intelligence-sweep` are scheduled nowhere** (`vercel.json` has only 2 crons; the GH workflow triggers only `daily`). They will never run in production.
- **Expected:** Every cron route is wired to a trigger, or removed.
- **Root cause:** Routes added without updating `vercel.json`/Actions.
- **Files:** `vercel.json`, `.github/workflows/daily-health.yml`, `src/app/api/cron/{feed-digest,intelligence-sweep}/route.ts`.
- **Proposed fix:** Add both to `vercel.json crons` (note: Vercel Hobby allows limited cron entries — verify plan limits) or trigger via the GH Actions schedule with `CRON_SECRET`; document the full cron map.
- **Acceptance:** All 4 cron routes have a scheduled trigger; a manual run log exists for each.

### I3 — Legacy direct mail/calendar connections are read but can no longer be created
- **Severity:** P2
- **Current:** Per the OAuth-consolidation decision, direct-OAuth **connect** routes for Mail/Calendar/Contacts were removed, yet the **read** adapters still query `mail_connections`/`calendar_connections` (`/api/mail/inbox` merges `via: "direct"` accounts; `/api/calendar/external` & `/sync` import `lib/calendar/{google,outlook}`). There is now no supported way to populate those tables — the direct path is reachable only by pre-existing rows.
- **Expected:** Either fully retire the direct path (delete `lib/mail/{gmail,outlook,tokens}`, `lib/calendar/{google,outlook,tokens}` and their route branches) or restore a connect route. Half-removed = dead branches + confusing maintenance.
- **Root cause:** Connect routes deleted; read/normalize adapters and table reads left behind.
- **Files:** `src/app/api/mail/{inbox,message/[id],send,status,disconnect}/route.ts`, `src/app/api/calendar/{external,sync,event/[id],disconnect}/route.ts`, `src/lib/mail/{gmail,outlook,tokens}.ts`, `src/lib/calendar/{google,outlook,tokens}.ts`.
- **Proposed fix:** Decide direction. If Composio-only: keep the `MailMessage` types, delete direct adapters/branches, drop or archive `mail_connections`/`calendar_connections` after migrating any rows. Update README/memory note accordingly.
- **Acceptance:** No code path references a connection type that has no creation route.

### I4 — Make/Composio workflow + webhook gaps
- **Severity:** P2
- **Current:** Inbound webhooks exist and are self-authenticating (`/api/webhooks/make` HMAC+secret, `/api/plaid/webhook` signed JWT). Outbound to Make exists (`lib/integrations/make.ts`, `lib/fund/notifyViaMake.ts`). But there's **no documented catalog** of which events fire which Make scenarios, no retry/dead-letter handling visible, and Composio has connect/execute but no **sync/poll** architecture (mail/calendar are read live, I2/L2) — there's no webhook from Composio toolkits to keep caches warm.
- **Expected:** A documented event→scenario map; idempotent webhook handlers with retry; a sync strategy for Composio-backed data (poll cron or provider push).
- **Root cause:** Webhooks added per-need without an overarching sync design.
- **Files:** `src/app/api/webhooks/make/route.ts`, `src/lib/integrations/make.ts`, `src/lib/fund/notifyViaMake.ts`.
- **Proposed fix:** Document the webhook/sync map in `docs/integrations.md`; add a Composio mail/calendar sync cron feeding caches (ties to L2); ensure webhook handlers are idempotent + logged to `audit_logs`.
- **Acceptance:** Every external trigger is documented; cached integration data refreshes on a schedule, not on read.

### I5 — Provider parity gaps
- **Severity:** P3
- **Current:** Mail send is implemented for Gmail + Outlook (Composio + direct), but actions like archive/delete/mark-read aren't (U2). Calendar create/delete exist; **update** is not obvious. Composio mail field-mapping is explicitly "defensive, unconfirmed against a live account" (`lib/mail/composio.ts:6-11`) — a real connected Gmail/Outlook may surface fields the normalizer misses.
- **Expected:** Consistent action set across providers; normalizers validated against live responses.
- **Files:** `src/lib/mail/composio.ts`, `src/app/api/calendar/event/[id]/route.ts`.
- **Proposed fix:** Verify normalizers with one live Gmail + one live Outlook grant; fill missing actions; add calendar event update.
- **Acceptance:** Same actions available regardless of provider; normalizers covered by fixtures from real payloads.

---

## 6. Prioritized roadmap

### P0 — Bugs (break a primary path, data loss, security)
*No unconditional P0 found in static review.* The closest are conditional/silent-failure issues escalated to P1 below. (Runtime verification — actually connecting a provider — could surface P0s, especially around the I1 health flow and I3 dead branches.)

### P1 — Production blockers
| ID | Finding | Why it blocks |
|---|---|---|
| **A4** | Nondeterministic migration ordering (dup `020_`/`036_`, gap `025`, ~15 unnumbered) | A fresh deploy may apply schema in the wrong/partial order → missing tables → A3 silent localStorage degrade in prod |
| **I1** | Health integrations dead-end (no callback/table/keys) | A surfaced feature that can never succeed; "Live Metrics" permanently empty |
| **I2** | `feed-digest` + `intelligence-sweep` crons unscheduled | Background intelligence/digests silently never run |
| **L1** | Console live-fetch fan-out, no cache-first | Slow, network-dependent first paint on the default landing page |
| **L2** | Mail live provider fan-out, no cache + silent per-account drop | Slow inbox + invisible account failures (also U2) |
| **U2** | Mail per-account failures swallowed; no archive/delete | "No silent failures" violation on a core module |

### P2 — UX polish & architecture hardening
| ID | Finding |
|---|---|
| **A1** | Split god modules (Vitality 1,935 / Notes 1,329 / Control Room 1,317 / Console 1,277 / Vault 1,176) |
| **A2** | Move provider dispatch out of mail/calendar routes into `lib/*` services; relocate `_lib.ts` |
| **A3** | Remove silent `localStorage` fallback in Literature/Training/Nutrition/Fitness hooks |
| **A5** | Generate + wire Supabase `Database` types; delete stale `types/database.ts` (dead `FundSnapshot`) |
| **A6** | Rewrite stale README; add architecture/integration docs |
| **A7** | Add Vitest; cover normalizers + SSRF guard |
| **I3** | Resolve half-removed direct mail/calendar path (retire or restore connect) |
| **I4** | Document webhook/sync map; add Composio sync cron; idempotent handlers |
| **L3** | Shared `useFund()` cache to kill duplicate fund fetches |
| **L4** | Add pagination/limits to tasks/notes/signals/transactions |
| **U1** | Make Console widgets click into their module |
| **U4** | Debrief reminder: persist to Supabase + real delivery, or remove |
| **U5** | Vitality: gate health devices behind honest "planned" state |

### P3 — Nice-to-have
| ID | Finding |
|---|---|
| **A8** | Redirect duplicate `/console`→`/command`, `/signals`→`/dispatch` |
| **L5** | Lazy-load TipTap editor + heavy modals |
| **U3** | Back Supper Club with a table or mark demo-only |
| **U6** | Real detail views for Objectives/Pipeline/Agenda/Atelier |
| **I5** | Provider parity (mail archive/delete, calendar update) + validate normalizers against live payloads |

---

## 7. What's genuinely strong (don't regress)

- **Provider-adapter pattern** for Composio mail/calendar/contacts — clean separation, additive design (Composio + direct coexist in one normalized list).
- **AI router** — cost-aware two-provider routing with per-mode eligibility, user override, and topic-aware heuristic fallbacks so the app degrades gracefully with zero AI keys.
- **Security posture** — RLS on every table, `security_definer` lockdown + `revoke public execute` migrations, SSRF guard (`lib/security/ssrf.ts`) on `/api/proxy` and `/api/og-image`, signed/HMAC webhooks, WebAuthn passkeys + MFA, middleware returning 401 JSON for APIs.
- **Cross-module routing spine** — Dispatch/Signals → Tasks/People/Notes/Literature via `signal_routes` is the feature that makes this a "personal OS" rather than a set of disconnected screens.
- **Consistent data hooks** — `usePeople/useTasks/useSignals/useObjectives/usePipeline` are textbook: full CRUD, optimistic local state, `useRealtimeRefresh`, `loading`/`signedIn` flags.

---

## 8. Suggested next actions (sequenced)

1. **A4** — Renumber/replay migrations against a fresh Supabase project; confirm every table exists in prod. *(unblocks A3, prevents silent data divergence)*
2. **I1 / I2** — Decide health: build the callback/table/sync or gate the UI; wire the two orphaned crons (or delete them).
3. **L1 / L2** — Add cache-first layers for Console widgets and Mail inbox; surface per-account mail errors (closes U2's silent-failure half).
4. **A5 / A3** — Generate DB types, wire the generic, then delete the now-safe localStorage fallbacks.
5. **A6** — Update README + write `docs/architecture.md` & `docs/integrations.md` reflecting the audited reality.
6. **A1 / A2** — Extract god modules and the mail/calendar service layer.
7. Backfill **A7** tests starting with the defensively-mapped Composio normalizers and SSRF guard.

*End of audit. No source files were modified.*
