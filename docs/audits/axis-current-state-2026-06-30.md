# AXIS Current State - 2026-06-30

> Issue: DOC-1 - Current-state repository truth pass  
> Scope: read current `main` repo files and create a short documentation artifact future agents can trust.  
> Sources inspected: `AGENTS.md`, `README.md`, `package.json`, `src/lib/store/nav.ts`, `docs/audits/axis-platform-audit.md`, `docs/linear/axis-mvp-issues.md`, `docs/architecture/integration-adapters.md`, `vercel.json`, `.github/workflows`, `src/app`, and `supabase/migrations`.

## Current Module Status

The most current surfaced module status source is `src/lib/store/nav.ts`. README is stale and should not be treated as the current product map.

| Section | Route | Module | Nav status | Current-state note |
|---|---|---|---|---|
| Daily | `/command` | Command | production | Canonical console route in nav. `/console` still exists as a duplicate legacy route. |
| Daily | `/dispatch` | Dispatch | production | Canonical signals route in nav. `/signals` still exists as a duplicate legacy route. |
| Daily | `/schedule` | Schedule | production | Surfaced production calendar/schedule module. |
| Daily | `/agenda` | Agenda | production | Surfaced production task/routine module. |
| Daily | `/mail` | Mail | production | Adapter architecture is implemented for Gmail/Outlook across direct OAuth and Composio; provider parity still needs live validation. |
| Daily | `/notes` | Notes | production | Surfaced production notes/editor module. |
| Plan | `/objectives` | Objectives | beta | Usable goal tracking; needs deeper review, error, and persistence validation before production treatment. |
| Plan | `/debrief` | Debrief | beta | Reflection capture is usable; reminder and AI summary flows need production validation. |
| Research | `/pipeline` | Pipeline | beta | Study/conference tracking persists; full research workflow needs end-to-end hardening. |
| Research | `/literature` | Literature | beta | Live source search works; saved articles/custom topics still include beta/local persistence caveats. |
| Life | `/people` | People | beta | CRM records persist; contacts matching and provider parity need production validation. |
| Life | `/briefing` | Briefing | beta | Feed reading is usable; source discovery and saved-item behavior need hardening. |
| Capital | `/fund` | Fund | beta | Provider-heavy finance module with Polygon/Massive, Plaid, and Public.com areas; configured/unconfigured states need validation. |
| Labs | `/vitality` | Vitality | lab | Mixes live Strava, local-only, and coming-soon health workflows. |
| Labs | `/atelier` | Atelier | lab | Exploratory creative discovery; provider availability and pin persistence need validation. |
| Labs | `/listening-vault` | Listening Vault | lab | Spotify-dependent music-room workflows; connect/playback fallbacks need validation. |
| Labs | `/library` | Library | lab | Uploads exist; broader library workflow needs storage/RLS/error validation. |
| Labs | `/supper-club` | Supper Club | lab | Recipe curation is intentionally exploratory and local-only. |
| System | `/control-room` | Control Room | production | Surfaced production integration/settings hub. |

## Current Route Inventory

### Page routes

| Route | Status / note |
|---|---|
| `/` | Landing/redirect entry route. |
| `/login` | Auth route. |
| `/command` | Canonical Command route. |
| `/console` | Legacy duplicate of Command; not in nav. |
| `/dispatch` | Canonical Dispatch route. |
| `/signals` | Legacy duplicate of Dispatch; not in nav. |
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
| `/fund/investing` | Fund investing subroute. |
| `/fund/watchlist` | Fund watchlist subroute. |
| `/fund/market` | Fund market subroute. |
| `/fund/spending` | Fund spending subroute. |
| `/fund/cashflow` | Fund cashflow subroute. |
| `/fund/net-worth` | Fund net-worth subroute. |
| `/fund/forecasting` | Fund forecasting subroute. |
| `/fund/advisor` | Fund advisor subroute. |
| `/fund/position/[symbol]` | Fund position detail route. |
| `/vitality` | Vitality module. |
| `/atelier` | Atelier module. |
| `/listening-vault` | Listening Vault module. |
| `/library` | Library module. |
| `/supper-club` | Supper Club module. |
| `/control-room` | Control Room module. |
| `/oauth-done` | OAuth popup completion route. |
| `/privacy` | Legal page. |
| `/terms` | Legal page. |

### API route groups

| Group | Current routes / notes |
|---|---|
| Mail | `/api/mail/inbox`, `/api/mail/message/[id]`, `/api/mail/message/[id]/action`, `/api/mail/send`, `/api/mail/status`, `/api/mail/disconnect`. |
| Calendar | `/api/calendar/status`, `/api/calendar/external`, `/api/calendar/sync`, `/api/calendar/conflicts`, `/api/calendar/event/[id]`, `/api/calendar/disconnect`. |
| Contacts / People | `/api/contacts/list`, `/api/contacts/status`, `/api/people/match-contacts`. |
| Integrations | `/api/integrations/composio/connect`, `/disconnect`, `/execute`, `/status`. |
| Widgets | `/api/widgets/weather`, `/daylight`, `/agenda`, `/air-quality`, `/markets`, `/training`, `/art`. |
| Fund / markets | `/api/fund/*`, `/api/massive/*`, `/api/plaid/*`, `/api/brokerage/*`. |
| AI / search | `/api/ai`, `/api/ai/status`, `/api/signals-ai`, `/api/signals/scan`, `/api/objectives/scan`, `/api/embeddings`, `/api/search`, `/api/search/quick`, `/api/search/semantic`. |
| Briefing / feeds | `/api/briefing/feeds`, `/api/briefing/fetch-feeds`, `/api/feeds/cached`. |
| Auth | `/api/auth/account`, `/settings`, `/forgot-password`, MFA routes, and passkey routes. |
| Spotify / Strava / health | Spotify OAuth/playback/library/search routes, `/api/strava`, and health-provider connect routes for Oura, Whoop, Fitbit, and Garmin. |
| Cron | `/api/cron/daily`, `/finance-daily`, `/feed-digest`, `/intelligence-sweep`; only daily and finance-daily are scheduled in `vercel.json`. |
| Misc | `/api/gallery`, `/api/literature`, `/api/notes/transcribe`, `/api/notes/youtube`, `/api/og-image`, `/api/profile/avatar`, `/api/proxy`, `/api/reader/extract`, `/api/webhooks/make`, `/api/plaid/webhook`. |

## Current Commands And Tests

`package.json` is the command source of truth. AGENTS.md is stale here.

| Purpose | Command | Current package.json value / note |
|---|---|---|
| Node engine | `node` | `24.x` |
| Install | `npm install` / `npm ci` | `npm ci` is used in GitHub Actions. |
| Dev server | `npm run dev` | `next dev` |
| Build | `npm run build` | `next build` |
| Start production server | `npm run start` | `next start` |
| Lint | `npm run lint` | `eslint .` |
| Unit tests | `npm run test` | `vitest run` |
| Public e2e tests | `npm run test:e2e` | `playwright test --project=public` |
| Authenticated e2e tests | `npm run test:e2e:auth` | `AXIS_E2E_AUTH=1 playwright test --project=authenticated` |
| Typecheck | `npx tsc --noEmit` | No package script; daily health workflow runs it directly. |
| Audit | `npm audit` | Daily health workflow runs `npm audit --audit-level=high`; weekly dependency audit also runs. |

## Current Production-Readiness Risks

| Risk | Evidence | Production impact |
|---|---|---|
| README is materially stale | README still frames AXIS as "Live App (Phase 1-2)" and labels many surfaced modules as static/future. | Future agents and collaborators may implement against false product state. |
| AGENTS command/test drift | AGENTS says Node 20+ and claims no test script exists; package.json requires Node 24.x and has Vitest/Playwright scripts. | Agents may skip available checks or use the wrong runtime baseline. |
| Widget/Console architecture remains a priority | Uploaded audit and current docs identify widget metadata/cache/interaction gaps. | Console can feel like decorative cards instead of a trustworthy operating system surface. |
| Migration ordering remains mixed | `supabase/migrations` contains numeric, decimal-like (`0281`, `0301`-`0304`), and timestamped filenames. | Fresh database replay and applied-order reasoning remain risky until validated. |
| Cron schedule drift | `vercel.json` schedules only `/api/cron/daily` and `/api/cron/finance-daily`; additional cron routes exist. | Expected feed/intelligence jobs may not run unless manually triggered or separately scheduled. |
| Provider parity requires live validation | Mail adapter docs report implementation across direct/Composio, while Outlook Composio caveats and broader provider workflows still need active-account validation. | A path can typecheck and render locally while failing for a real connected account. |
| Cache-first architecture is incomplete | Prior audit and uploaded report call out Console/Mail provider fan-out and widget cache gaps. | First paint and provider failure behavior may be slow or brittle. |
| Some lab/local workflows are surfaced | Supper Club and parts of Vitality/Literature/Debrief have local-only or lab caveats. | Users may over-trust state unless UI and docs keep labels honest. |
| Sentry/Vercel evidence is a production gate | Delivery workflow requires preview validation and post-preview Sentry review. | Local checks alone are insufficient before merge to production. |

## Documentation Drift List

| File | Drift | Required follow-up |
|---|---|---|
| `README.md` | Stale Phase 1-2 framing; stale route table; stale "implemented vs stubbed" section; stale migration instructions naming only `001` and `002`; incomplete stack. | DOC-2 should rewrite README around the current personal operating system, current nav modules, current scripts, and migration caveats. |
| `AGENTS.md` | Stale Node version and test documentation; says tests are missing even though package.json includes `test`, `test:e2e`, and `test:e2e:auth`. | DOC-3 should update only the command/status drift while preserving delivery, privacy, security, and final-response rules. |
| `docs/audits/axis-platform-audit.md` | Useful but dated 2026-06-27 and predates package/test drift fixes and later migrations. Some migration-file examples are no longer exact. | Keep as historical audit; use this current-state doc for 2026-06-30 repo truth. |
| `docs/linear/axis-mvp-issues.md` | Mail production plan has older issue ordering; integration adapter docs now mark mail adapter foundation implemented. | Future issue plan should reconcile the mail-first plan with the uploaded audit's widget/console priority. |
| `docs/architecture/integration-adapters.md` | More current for Mail adapters than older audit text; still documents live-validation caveats. | Treat as source of truth for Mail adapter architecture until Calendar/Contacts adapters are added. |

## Tembo Role Statement

Tembo role is unspecified in inspected repo config. `AGENTS.md` and docs require Supabase/Tembo validation, but inspected files do not define whether Tembo is primary Postgres, analytics Postgres, a queue/cache, or unused. Do not route data to Tembo or claim a Tembo role until future configuration proves it.

## Next 10 Recommended Codex Issues

1. DOC-2 - Update README route/module/status tables.
2. DOC-3 - Update AGENTS command/status drift.
3. WID-1 - Add a first-class widget registry and semantic `WidgetShell` contract without changing widget data behavior.
4. WID-DATA-1 - Design and migrate a Supabase `widget_cache` table with RLS, after migration-order validation.
5. WID-DATA-2 - Add a batched widget read/revalidate API with partial-failure responses and safe Sentry metadata.
6. CONSOLE-1 - Extract Console widget grid/rendering from `ConsoleModule` while preserving behavior.
7. CONSOLE-7 - Audit lab/static/live labels in Console widgets and remove editable live values.
8. MAIL-VALIDATE-1 - Run live provider validation for direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook list/detail/actions.
9. OBS-CRON-1 - Reconcile cron routes with `vercel.json` schedules and document manual vs scheduled jobs.
10. DATA-1 - Validate Supabase migration replay/order on a fresh target and document applied migration state before any schema work.
