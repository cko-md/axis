# AXIS Phase-Based Hardening Plan

> Issue: DOC-4 - Regenerate phase-based Codex issue plan  
> Repo: `cko-md/axis`  
> Updated: 2026-07-01  
> Source basis: implementation reality on `main`, `AGENTS.md`, `README.md`, `docs/audits/axis-current-state-2026-06-30.md`, `docs/architecture/integration-adapters.md`, `docs/linear/axis-mvp-issues.md`, and the phase hardening brief.

## Operating Contract

Every issue is one Codex-sized branch and one draft PR. Do not merge until preview, Supabase/Tembo, Sentry, manual workflow, and human approval gates pass.

Every promoted feature must satisfy:

```text
list -> detail -> action -> persistence -> feedback -> error state
```

Every user-facing surface should explicitly handle:

```text
loading
empty
error
stale
disconnected
lab
local-only
permission-denied
provider-unconfigured
```

Tembo role is unspecified in inspected repo config. Do not route data to Tembo unless future configuration proves its role.

## Current Reality Adjustments

- README and AGENTS are mostly aligned with current scripts and nav status; keep DOC-2/DOC-3 focused on drift, not full rewrites.
- Mail adapter foundation is already implemented for direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook. Future Mail work should validate and polish, not re-create the adapter layer.
- Widget runtime pieces already exist: `src/lib/widgets/{registry,types}.ts`, `/api/widgets/batch`, `src/lib/hooks/useWidgetData.ts`, and `supabase/migrations/202606302157_widget_cache.sql`.
- Widget work should begin with validation/hardening of existing registry/cache/batch behavior, then Console extraction and polish.
- Migration ordering remains mixed and must be audited before new schema work.
- Production deployment is main-triggered, and `.github/workflows/deploy.yml` also runs `npx vercel deploy --prod` on pushes to `main`; confirm the active production path before merging.

## Phase 0 - Documentation, Truth, And Delivery Alignment

Purpose: prevent future work from using stale assumptions.

| Issue | Title | Scope | Status |
|---|---|---|---|
| DOC-1 | Current-state repository truth pass | Audit implementation reality, route/module status, commands, migration/deploy risk, theme/rendering surfaces. | In review |
| DOC-2 | README route/module/status update | Keep README aligned with nav, routes, scripts, widget reality, deployment gate, and migration caveats. | In review |
| DOC-3 | AGENTS command and workflow correction | Keep durable agent instructions aligned with package scripts, widget locations, deployment workflow, and gates. | In review |
| DOC-4 | Regenerate phase-based Codex issue plan | This file. Reconcile the older mail-first plan with current implementation and the phase hardening program. | In progress |
| DOC-5 | Design/rendering audit addendum | Dedicated visual audit for themes, Interface Studio, fonts, density, presence, app shell, mobile, reduced motion, and contrast. | Todo |
| DATA-0 | Migration and deployment truth probe | Document migration filename order, applied-state access, Supabase CLI/connector availability, Tembo role, and deploy workflow ownership. | Todo |

Exit gate: README/AGENTS/docs agree with implementation reality; Tembo role is explicit as configured or unspecified; theme/rendering audit exists; no runtime changes except documentation links.

## Phase 1 - Rendering, Theme, Typography, And Presence Foundation

Purpose: make the visual foundation sophisticated before widget/module polish.

| Issue | Title | Scope |
|---|---|---|
| THEME-1 | Silver/chrome light theme | Rework current warm parchment light tokens into a whiter, silver/chromatic gallery chrome theme; validate Command, Mail, Notes, Fund, Control Room, one beta, one lab. |
| THEME-2 | Token parity audit | Align dark/dim/slate/light semantic tokens for surfaces, chrome, borders, charts, status states, and presence glow. |
| THEME-3 | Interface Studio UX polish | Add preview cards, saved/local state clarity, reset state, focus/escape handling, and mobile drawer QA. |
| THEME-4 | Font customization previews | Keep finite font choices, add previews, validate no layout/hydration surprises. |
| THEME-5 | Density/radius QA | Validate compact/default/cozy and radius controls across modules and fixed-format UI. |
| THEME-6 | Personalization persistence strategy | Decide and implement local-only labeling vs Supabase/user_preferences sync for interface settings. |
| PRESENCE-1 | Presence forms audit | Audit Axiom/Codex/Nova visual fit, accessibility, mobile, privacy, fallback/offline behavior. |
| PRESENCE-2 | Presence rendering hardening | Improve motion, reduced-motion, keyboard/focus, mobile layout, and visibility states. |
| PRESENCE-3 | Companion AI privacy and context | Validate module context, safe prompts, provider-unconfigured state, and no private-content logging. |
| RENDER-1 | App shell performance pass | Profile atmosphere layers, grain/blur, sidebar, scroll/focus behavior, mobile performance, reduced transparency/motion. |

Exit gate: chrome light theme is production-polished; Interface Studio is trustworthy; presence forms are honest and accessible; reduced motion works.

## Phase 2 - Shared UX Primitives And Widget Interaction System

Purpose: standardize reusable interaction primitives without rebuilding existing widget data from scratch.

| Issue | Title | Scope |
|---|---|---|
| WID-VALIDATE-1 | Existing widget architecture validation | Validate `WIDGET_REGISTRY`, `/api/widgets/batch`, `widget_cache`, `useWidgetData`, status mapping, and RLS assumptions. |
| WID-1 | WidgetShell over existing registry | Add or refine a shared `WidgetShell` around current widget definitions; migrate one low-risk real widget. |
| WID-2 | Widget status/action primitives | Add/refine `WidgetStatusBadge`, `WidgetSkeleton`, `WidgetActionMenu` using existing statuses. |
| WID-3 | Widget detail drawer | Add generic detail drawer behavior for drawer-backed widgets with keyboard and reduced-motion support. |
| WID-4 | Semantic motion policy | Define reduced-motion-safe transitions for widgets, drawers, status changes, and shell chrome. |
| WID-5 | Widget accessibility baseline | Keyboard activation, aria labels, focus return, target sizing, and contrast checks. |
| UX-1 | Shared state components | Standardize loading/empty/error/stale/disconnected/lab/local-only/provider-unconfigured states. |
| UX-2 | Detail panel anatomy | Standardize title, source, freshness, actions, errors, and related links for drawers/panels. |
| UX-3 | Destructive action/undo patterns | Confirmations, undo where appropriate, success/error feedback, and Sentry-safe metadata. |

Exit gate: one real widget uses shared primitives; no fake live data; keyboard/reduced-motion support works.

## Phase 3 - Widget Data Architecture And Console / Command Polish

Purpose: make `/command` feel like a real operating-system front door.

| Issue | Title | Scope |
|---|---|---|
| WID-DATA-VERIFY-1 | Widget cache schema/RLS verification | Validate `widget_cache` migration order, applied state, owner policies, safe payload constraints. |
| WID-DATA-2 | Batch widget hardening | Harden `/api/widgets/batch` partial failures, timeout handling, safe Sentry metadata, and cache writes. |
| WID-DATA-3 | Cache-first widget UX | Confirm Supabase cached reads appear before refresh; surface stale/fallback states clearly. |
| WID-DATA-4 | Stale-while-revalidate behavior | Add freshness affordances and retry behavior without blocking first paint. |
| WID-DATA-5 | Widget provider observability | Add safe timing/error metadata by provider and widget id, no private payloads. |
| CONSOLE-1 | Extract WidgetGrid | Split widget grid/rendering from `ConsoleModule` while preserving layout/capture behavior. |
| CONSOLE-2 | Extract core Console sections | Reduce god-component risk by moving sections into focused components. |
| CONSOLE-3 | Static/live honesty pass | Remove, disable, or label fake/static/lab metrics and dead cards. |
| CONSOLE-4 | Console drill-ins | Ensure every visible card opens detail, routes, acts, or is visibly disabled/lab with reason. |
| CONSOLE-5 | Mobile and keyboard pass | Polish touch/keyboard behavior and layout persistence states. |
| CONSOLE-6 | Interface Studio QA | Validate Console across theme/accent/density/font/presence/motion representative matrix. |

Exit gate: first paint avoids avoidable provider fan-out; each widget has source/freshness/status; Console cards are not decorative dead ends.

## Phase 4 - Production Daily Modules UX Completeness

Purpose: bring production Daily modules to a cohesive vertical-slice standard.

| Area | Issues |
|---|---|
| Mail | MAIL-VALIDATE-1 provider parity; MAIL-2 skeletons/detail retry; MAIL-3 premium reader; MAIL-4 mobile/keyboard actions; MAIL-5 theme/typography QA; MAIL-6 reply/send parity; MAIL-7 archive/delete/mark-read; MAIL-8 pagination/load-more; MAIL-9 cache-first mail reads. |
| Dispatch | DISP-1 detail view/source traceability; DISP-2 route-to-task/note/person/literature; DISP-3 widget drill-in; DISP-4 duplicate/already-routed/error states; DISP-5 theme/status QA. |
| Agenda | AGENDA-1 task detail drawer; AGENDA-2 source links; AGENDA-3 schedule focus block action; AGENDA-4 state polish; AGENDA-5 density/theme QA. |
| Schedule | CAL-1 event detail panel; CAL-2 provider parity validation; CAL-3 conflict/provider states; CAL-4 widget drill-ins; CAL-5 rendering/theme pass. |
| Notes | NOTES-1 lazy-load/editor bundle pass; NOTES-2 autosave/conflict/error UX; NOTES-3 search/semantic states; NOTES-4 note-to-task/signal/pipeline/literature actions; NOTES-5 editor theme/font/density pass. |

Exit gate: Console capture -> Dispatch -> Agenda task -> Schedule block -> Notes/Debrief reference works; all Daily modules satisfy the vertical-slice contract.

## Phase 5 - Beta Planning And Research Modules

| Area | Issues |
|---|---|
| Objectives | OBJ-1 detail/KR CRUD; OBJ-2 progress history/source explanation; OBJ-3 linked tasks/Debrief; OBJ-4 rendering/theme pass. |
| Debrief | DEBRIEF-1 reminder truth pass; DEBRIEF-2 review detail/history; DEBRIEF-3 real tasks/calendar/objectives; DEBRIEF-4 AI fallback/next-action creation; DEBRIEF-5 typography/theme pass. |
| Pipeline | PIPE-1 item detail; PIPE-2 source links; PIPE-3 movement/archive/delete/history; PIPE-4 AI project draft safety; PIPE-5 board rendering pass. |
| Literature | LIT-1 persistence truth/local-only badge; LIT-2 paper detail/annotation/source states; LIT-3 route paper to Notes/Pipeline/Tasks; LIT-4 search failure/source trust; LIT-5 reader typography pass. |

Exit gate: Literature search -> save paper -> route to Pipeline -> create task -> reflect in Debrief/Objectives works; no silent signed-in localStorage persistence.

## Phase 6 - Life And Capital Beta Modules

| Area | Issues |
|---|---|
| People | PEOPLE-1 person detail/timeline; PEOPLE-2 contact import/match UX; PEOPLE-3 follow-up routing; PEOPLE-4 duplicate/merge/error states; PEOPLE-5 card/table rendering pass. |
| Briefing | BRIEF-1 source discovery/validation; BRIEF-2 saved item detail/route actions; BRIEF-3 refresh stale/error states; BRIEF-4 cron wiring/manual-only label; BRIEF-5 reader/source rendering pass. |
| Fund | FUND-1 shared fund cache/service; FUND-2 quote freshness/provider state; FUND-3 chart polish; FUND-4 Plaid/Public/Massive disconnected/non-execution states; FUND-5 widgets/targets; FUND-6 chart/table/theme pass. |

Exit gate: People follow-up -> Agenda task -> Schedule block works; Briefing item -> Note/Literature/Pipeline works; Fund market widget -> Fund detail with stale/provider state works.

## Phase 7 - Lab And Immature Modules

| Area | Issues |
|---|---|
| Vitality | VITALITY-1 surface classification; VITALITY-2 manual workout or Strava MVP; VITALITY-3 wearable metric honesty; VITALITY-4 widget integration; VITALITY-5 chart/rendering pass. |
| Library | LIBRARY-1 upload/download/delete hardening; LIBRARY-2 file detail/source metadata; LIBRARY-3 Mail attachment validation; LIBRARY-4 storage error/RLS; LIBRARY-5 grid/list rendering. |
| Atelier | ATELIER-1 source availability/error states; ATELIER-2 pin/moodboard persistence; ATELIER-3 detail route-to-note/library; ATELIER-4 moodboard rendering pass. |
| Listening Vault | VAULT-1 Spotify provider health; VAULT-2 saved detail/notes/tags; VAULT-3 playback/search/library failures; VAULT-4 audio-room rendering pass. |
| Supper Club | SUPPER-1 decide lab-local vs Supabase MVP; SUPPER-2A local-only label/export/import; SUPPER-2B Supabase recipe tables/RLS; SUPPER-3 recipe detail/planning; SUPPER-4 recipe rendering. |

Exit gate: every lab module is either unmistakably lab/local-only or has one complete persisted MVP workflow.

## Phase 8 - Control Room, Navigation, AI Layer, And Production Readiness

| Area | Issues |
|---|---|
| Control Room | CTRL-1 provider health model; CTRL-2 fetch/service extraction; CTRL-3 reconnect/disconnect UX; CTRL-4 diagnostics/missing-env states; CTRL-5 rendering pass. |
| Navigation / IA | NAV-1 canonical route redirects; NAV-2 status badge clarity; NAV-3 command palette/README alignment; NAV-4 sidebar/topbar density pass. |
| AI layer | AI-1 inventory AI actions; AI-2 typed action registry; AI-3 migrate Mail/Notes/Debrief/presence AI calls; AI-4 failure/privacy validation. |
| Production | PROD-1 migration ordering/replay audit; PROD-2 generated Supabase types; PROD-3 RLS verification; PROD-4 smoke/e2e tests; PROD-5 Sentry/Vercel gate; PROD-6 final checklist; PROD-7 visual regression checklist. |

Exit gate: provider health is visible; nav/docs/routes agree; typed AI actions cover high-risk calls; production gate is repeatable.

## Per-Issue PR Requirements

Every PR should include:

```text
Summary
Scope
Files changed
Screens/routes affected
Supabase/Tembo/RLS impact
Sentry/observability impact
Vercel preview validation
Manual test checklist
Cross-module validation
Cross-theme validation
Known risks
Rollback notes
```

Use draft PRs until local checks, preview, Supabase/Tembo notes, and Sentry review are complete.
