# AXIS Current State - 2026-06-30

> Issue: DOC-1 - Current-state repository truth pass  
> Scope: read current `main` repo files and create a short documentation artifact future agents can trust.  
> Sources inspected: `AGENTS.md`, `README.md`, `package.json`, `src/lib/store/nav.ts`, `docs/audits/axis-platform-audit.md`, `docs/linear/axis-mvp-issues.md`, `docs/architecture/integration-adapters.md`, `vercel.json`, `.github/workflows`, `src/app`, and `supabase/migrations`.

## Current Module Status

The most current surfaced module status source is `src/lib/store/nav.ts`. The current README has been updated to mirror this production/beta/lab map; if future drift appears, prefer `src/lib/store/nav.ts` and implementation reality.

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
| Misc | `/api/gallery`, `/api/literature`, `/api/notes/transcribe`, `/api/notes/youtube`, `/api/og-image`, `/api/profile/avatar`, `/api/proxy`, `/api/tavily/extract`, `/api/webhooks/make`, `/api/plaid/webhook`. |

## Current Commands And Tests

`package.json` is the command source of truth. Current `AGENTS.md` now matches the Node 24.x baseline and available test scripts.

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
| README drift is currently corrected | README now describes AXIS as the personal operating system, lists current routes from `src/lib/store/nav.ts`, includes Node 24.x/package scripts, and warns about migration ordering. | Keep README aligned during future module/status changes. |
| AGENTS command/test drift is currently corrected | AGENTS now documents Node 24.x, `npm run test`, Playwright scripts, and direct `npx tsc --noEmit`. | Keep `AGENTS.md` aligned whenever package scripts or delivery gates change. |
| Widget/Console architecture is partially implemented and remains a priority | `src/lib/widgets/{registry,types}.ts`, `/api/widgets/batch`, `useWidgetData`, and `widget_cache` exist; older docs still describe some of this as future work. | Future agents must inspect current widget code before running WID issues; remaining work is validation, polish, and cache/error behavior hardening, not greenfield scaffolding. |
| Migration ordering remains mixed | `supabase/migrations` contains numeric, decimal-like (`0281`, `0301`-`0304`), and timestamped filenames. | Fresh database replay and applied-order reasoning remain risky until validated. |
| Widget cache migration comment is stale | `202606302157_widget_cache.sql` says runtime code will not read the table until WID-DATA-3, but `src/lib/hooks/useWidgetData.ts` already reads `widget_cache`. | Do not edit applied migrations casually; document this drift and validate applied state before schema work. |
| Cron schedule drift | `vercel.json` schedules only `/api/cron/daily` and `/api/cron/finance-daily`; additional cron routes exist. | Expected feed/intelligence jobs may not run unless manually triggered or separately scheduled. |
| Production deployment path needs confirmation | `README.md` says merging to `main` triggers production deployment, while `.github/workflows/deploy.yml` also runs `npx vercel deploy --prod` on pushes to `main`. | Treat production deploy as main-driven, but confirm whether Vercel Git integration, GitHub Actions, or both are active before merging. |
| Provider parity requires live validation | Mail adapter docs report implementation across direct/Composio, while Outlook Composio caveats and broader provider workflows still need active-account validation. | A path can typecheck and render locally while failing for a real connected account. |
| Cache-first architecture is incomplete | Prior audit and uploaded report call out Console/Mail provider fan-out and widget cache gaps. | First paint and provider failure behavior may be slow or brittle. |
| Some lab/local workflows are surfaced | Supper Club and parts of Vitality/Literature/Debrief have local-only or lab caveats. | Users may over-trust state unless UI and docs keep labels honest. |
| Sentry/Vercel evidence is a production gate | Delivery workflow requires preview validation and post-preview Sentry review. | Local checks alone are insufficient before merge to production. |

## Theme And Rendering Truth Pass

Sources inspected: `src/app/layout.tsx`, `src/app/globals.css`, `src/components/layout/AppShell.tsx`, `src/components/layout/Mascot.tsx`, `src/components/theme/ThemeProvider.tsx`, `src/components/theme/InterfaceStudioDrawer.tsx`, and `src/lib/theme/interface-settings.ts`.

| Surface | Current implementation | Follow-up needed |
|---|---|---|
| Theme modes | `globals.css` defines dark default plus `html.dim`, `html.slate`, and `html.light`. Current light mode is still described in CSS as warm "museum gallery"/parchment rather than the requested whiter silver/chrome gallery theme. | THEME-1 should rework light tokens into the silver/chrome direction and QA contrast across modules. |
| Theme persistence | `ThemeProvider` stores `axis-theme` in `localStorage` and applies the theme after mount. It uses `suppressHydrationWarning`; there is still a possible first-paint dark/default flash. | THEME-6 should decide whether interface settings remain local-only, sync to Supabase/user preferences, or show an explicit local-only persistence state. |
| Interface settings persistence | `axis-interface-settings` is localStorage-backed. Settings include accent, surface tone, radius, display/body faces, density, companion form, presence visibility, location services, and notification preferences. | Add visible persistence/error/local-only clarity in Interface Studio before treating personalization as account-level. |
| Interface Studio UX | Drawer has mode/accent/surface/radius/font/density/presence/location/notification/reset controls. It has reset confirmation and live CSS variable application. | Add richer preview cards, keyboard/focus trapping, escape handling, clearer saved/local state, and mobile drawer QA. |
| Font customization | `layout.tsx` loads Archivo, Archivo Narrow, Fraunces, JetBrains Mono, Playfair Display, Space Grotesk, Inter, IBM Plex Sans, and Bebas Neue. Interface Studio exposes finite display/body choices; no arbitrary user URLs. | Validate layout shifts and bundle impact, then add preview cards for chosen pairings. |
| Density and radius | `body[data-density]` changes card padding, grid gap, view padding, and spacing tokens. Radius is applied through `--r` and `--rl`. | Audit compact/cozy text fit and module-specific fixed controls across representative routes. |
| Accent presets | Accent presets include gold, marine, clay, bone, sage, and chrome; the pasted cross-theme matrix mentions gold, marine, clay, and chrome. | Align docs/QA matrix with implemented presets and decide whether bone/sage are supported production presets. |
| App shell atmosphere | `AppShell` renders depthfield, wash, aurora layers, haze, fall, vignette, night stars, grain, responsive sidebar states, status banners for beta/lab modules, command palette, dynamic Mascot, and Interface Studio. | RENDER-1 should profile animation/transparency cost, scroll/focus behavior, and mobile performance. |
| Reduced motion | `globals.css` includes multiple `prefers-reduced-motion: reduce` blocks for global atmosphere, widget drawer, presence forms, and vault/media room effects. | Validate with browser reduced-motion setting; some transitions remain and need an explicit policy. |
| Presence forms | `Mascot.tsx` implements Axiom, Codex, and Nova as SVG/interactive companions. Visibility and form are driven by interface settings. Axiom stores focus in `localStorage` and calls `/api/ai`; companion prompts include module context. | PRESENCE issues should audit privacy copy, offline/provider failure UX, local-only focus persistence, accessibility labels/focus, and mobile behavior. |
| Module status rendering | Non-production nav items surface beta/lab banners in `AppShell` with reasons/actions from `src/lib/store/nav.ts`. | Keep nav labels honest and extend status vocabulary where disconnected/local-only/provider-unconfigured states are needed inside modules. |

## Documentation Drift List

| File | Drift | Required follow-up |
|---|---|---|
| `README.md` | Current in this checkout for product framing, nav status, route inventory, scripts, Tembo statement, and migration caveats. | Keep it aligned as DOC/phase issues change implementation reality. |
| `AGENTS.md` | Current in this checkout for Node 24.x and the available package scripts/checks. | Keep delivery, privacy, security, and final-response rules intact when future command drift is corrected. |
| `docs/audits/axis-platform-audit.md` | Useful but dated 2026-06-27 and predates package/test drift fixes and later migrations. Some migration-file examples are no longer exact. | Keep as historical audit; use this current-state doc for 2026-06-30 repo truth. |
| `docs/linear/axis-mvp-issues.md` | Mail production plan has older issue ordering; integration adapter docs now mark mail adapter foundation implemented, and widget cache/batch work exists in code. | Future issue plan should reconcile the mail-first plan, phase-based pasted plan, and already-landed widget/cache implementation. |
| `docs/architecture/integration-adapters.md` | More current for Mail adapters than older audit text; still documents live-validation caveats. | Treat as source of truth for Mail adapter architecture until Calendar/Contacts adapters are added. |
| `supabase/migrations/202606302157_widget_cache.sql` | Header comment says runtime code will not read the table until WID-DATA-3, but runtime code now reads/writes `widget_cache`. | Leave applied migration content alone unless migration state confirms it is safe; track comment drift in future schema audit. |

## Tembo Role Statement

Tembo role is unspecified in inspected repo config. `AGENTS.md` and docs require Supabase/Tembo validation, but inspected files do not define whether Tembo is primary Postgres, analytics Postgres, a queue/cache, or unused. Do not route data to Tembo or claim a Tembo role until future configuration proves it.

## Next 10 Recommended Codex Issues

1. DOC-2 - Review README against this corrected audit and either close as already aligned or patch only newly found drift.
2. DOC-3 - Review AGENTS against `package.json`/workflow reality and either close as already aligned or patch only newly found drift.
3. DOC-4 - Regenerate the phase-based Codex issue plan from implementation reality, including already-landed widget registry/cache/batch pieces.
4. DOC-5 - Add the requested design/rendering audit addendum for themes, Interface Studio, fonts, density, presence, app shell, mobile, and reduced motion.
5. DATA-1 - Validate Supabase migration replay/order on a fresh target and document applied migration state before any schema work.
6. WID-VALIDATE-1 - Validate existing widget registry, `/api/widgets/batch`, `widget_cache`, and `useWidgetData` behavior before planning additional widget architecture changes.
7. CONSOLE-1 - Extract Console widget grid/rendering from `ConsoleModule` while preserving behavior.
8. CONSOLE-7 - Audit lab/static/live labels in Console widgets and remove editable live values.
9. MAIL-VALIDATE-1 - Run live provider validation for direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook list/detail/actions.
10. OBS-CRON-1 - Reconcile cron routes with `vercel.json` schedules and document manual vs scheduled jobs.
