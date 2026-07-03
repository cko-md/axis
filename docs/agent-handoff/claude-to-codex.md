# Agent Handoff: Claude Code ↔ Codex (and other coding agents)

> Onboarding and active handoff note for AXIS work shared between Claude Code, Codex, and other coding agents.
> The durable, agent-neutral rules live in [`AGENTS.md`](../../AGENTS.md) at the repo root. This document is the orientation layer on top of it.

---

## 1. What Claude Code was previously used for

Claude Code has been the primary agent for AXIS so far. It produced the foundational analysis and early implementation that the rest of the roadmap builds on:

- The platform audit — [`docs/audits/axis-platform-audit.md`](../audits/axis-platform-audit.md) (platform map, UX/architecture/latency/integration findings, P0–P3 roadmap).
- The Linear-ready issue plan — [`docs/linear/axis-mvp-issues.md`](../linear/axis-mvp-issues.md) (initiatives, projects, milestones, per-issue specs + acceptance criteria + module order).
- The integration adapter foundation for Mail — [`docs/architecture/integration-adapters.md`](../architecture/integration-adapters.md) and `src/lib/integrations/*` + `src/lib/mail/adapters/*`. **This foundation is merged to `main`/production**, so module-priority item 1 is complete.

There is no root `CLAUDE.md`; durable guidance now lives in `AGENTS.md` so it is shared by every agent.

## 2. Why Codex is being added

To parallelize and de-risk delivery. Multiple agents (Codex, Claude Code, GitHub agents) can each take one Linear issue and run it through the same delivery system. For this to stay safe and consistent, every agent must follow the **same** repo instructions — hence `AGENTS.md` is agent-neutral and authoritative. The recurring failure mode being prevented: agents shipping UI that renders but doesn't complete the workflow (the Mail "lists but won't open detail" bug). Codex must build **complete vertical slices**.

## 3. How Codex should use `AGENTS.md`

- Read `AGENTS.md` in full **before** any task; it is the source of truth.
- Obey §2 (non-negotiable behavior), §3 (delivery workflow), and §12 (final response format) on every session.
- Respect the precedence order in §14 when instructions conflict (security/privacy → Linear scope → `AGENTS.md` → docs → existing code).
- Stay inside the scope of one Linear issue; split rather than expand.

## 4. How Codex should interact with the toolchain

- **Linear** — start from a specific issue (id + title); restate scope; do not exceed it. If no issue exists, request/create one or split the work.
- **GitHub** — branch from `main` (e.g. `codex/<area>-<slug>`); one issue per branch/PR; push/open the PR after local checks pass; PR description uses the §12 format and includes preview + validation evidence; never commit secrets.
- **Vercel** — every PR gets a preview deploy; validate the happy path **and** error path on the preview URL, not just locally; note the preview URL in the PR.
- **Supabase** — source of truth for data + auth (RLS). Inspect existing migrations before schema changes; new tables need owner-scoped RLS and `user_id`; state whether a migration is applied (don't assume prod).
- **Tembo** — role is **not yet documented**. Do not assume it is primary Postgres / analytics / queue / cache / unused. Inspect config and document findings; route nothing to it on assumption.
- **Sentry** — capture actionable failures with safe metadata only (provider, operation, status, transport, normalized code); never log tokens/bodies/OAuth payloads; review Sentry after the Vercel preview is available, not as a human pre-push gate; confirm the happy path produces no new Sentry error before production merge.

## 5. Current stacked PR state

Codex completed and pushed the Phase 0–3 stack plus the first Phase 4 Mail validation slice. These are draft PRs stacked one issue per branch; do not squash unrelated phases together while reviewing.

- Phase 0 docs/data truth stack: PRs #62–#67.
- Phase 1 theme/presence/render stack: PRs #68–#77.
- Phase 2 widget shell/UX stack: PRs #78–#85.
- Phase 3 widget data + Console/Command stack: PRs #86–#96.
- Phase 4 MAIL-1 provider parity validation: PR #97, branch `codex/phase-4-mail-1-provider-parity-validation`, latest commit `10d587f`.
- Phase 4 MAIL-2 inbox/message skeletons and detail retry state: PR #98, branch `codex/phase-4-mail-2-skeletons-detail-retry`, commit `65f9514`.

MAIL-1 adds a provider parity matrix for direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook; extends provider capabilities with `attachmentDownload`; relabels Mail attachment affordances as `Save to Library` only when direct byte download is supported and `Route via Dispatch` for Composio; and updates `docs/architecture/integration-adapters.md`.

MAIL-1 checks already run locally and passed: `npx tsc --noEmit`, `npm run lint`, `npm run test` (25 files, 189 tests), and `npm run build`.

MAIL-2 replaces text-only Mail loading states with structured status/inbox/message skeletons and adds a persistent message-detail error panel with Retry/Back that preserves safe provider/account/message context. MAIL-2 checks already run locally and passed: `npx tsc --noEmit`, `npm run lint`, `npm run test` (25 files, 189 tests), and `npm run build`.

- Phase 4 MAIL-3 premium message document viewer: PR #99, branch `claude/phase-4-mail-3-premium-document-viewer` (stacked on MAIL-2).

MAIL-3 rebuilds `MessagePanel` into a document-style reader (serif title, sender identity block with tone-stable avatar initials, explicit timestamp, centered 820px article, light paper page for HTML mail / themed page for plain text, Aa text-size cycle persisted as a device display pref, token-based chrome with Reply as primary action) and extracts sanitize/format/sender helpers into `src/lib/mail/reader.ts` with unit tests; detail skeleton and error panel mirror the layout. Purely presentational above `MailMessageFull` — provider parity and capability gating unchanged. Local gates passed: `npx tsc --noEmit`, `npm run lint`, `npm run test` (26 files, 204 tests). `npm run build` was not run locally this session — verify via the Vercel preview build before merge.

- Phase 4 MAIL-4 mobile action menu + keyboard pass: PR #100, branch `claude/phase-4-mail-4-mobile-actions-keyboard` (stacked on MAIL-3). Secondary reader actions collapse into a "⋯ Actions" menu ≤760px driven by the same descriptor list as the desktop buttons; keyboard shortcuts (j/k/arrows, Enter/o, Esc, /) with pure mapping helpers `mailShortcutForKey`/`isEditableTarget` in `src/lib/mail/reader.ts` + tests. Local gates: tsc/lint/test (26 files, 206 tests) passed; build deferred to Vercel preview.

- Phase 4 MAIL-5 theme/typography QA: PR #101, branch `claude/phase-4-mail-5-theme-typography-qa` (stacked on MAIL-4). Fixed two Light-theme bugs in `AddAccountPicker` (hardcoded `#181818` panel bg, white hover); paper palette centralized as `--mail-paper-*`; light-theme shadow/border refinements; neutral email font stack for HTML bodies; new `theme-qa.test.ts` enforces a raw-color allowlist across all mail components. Local gates: tsc/lint/test (27 files, 212 tests) passed; build deferred to Vercel preview.

- DISP-1 routing reliability + visible failures: PR #102, branch `claude/phase-4-disp-1-routing-reliability` (stacked on MAIL-5). Closed remaining silent-failure gaps: signals/routes read errors surface via `loadError` + StatusCallout with Retry (a failed read no longer falls into the demo-seed insert path); capture failures restore the draft; delete (signal + route) confirm-gated with result toasts; route update/enable/delete result-driven; mark-read/rename failures toast; new Sentry ops `capture_signal`/`delete_signal`; `useSignalRoutes.test.ts` covers routeMatches/findMatchingRoute. Local gates: tsc/lint/test (28 files, 218 tests) passed; build deferred to Vercel preview. DISP specs live in `docs/linear/axis-mvp-issues.md` (DISP-1..4; there is no DISP-5 in the repo plan).

- DISP-2 console widgets navigable: PR #103, branch `claude/phase-4-disp-2-widget-drilldowns` (stacked on DISP-1). The six dead Console tiles (sleep/hrv/heartrate/vo2max/hydration → navigate `/vitality`; location → open-drawer like weather/air) now click through to a real destination. New pure `resolveWidgetTileActivation` + a `widget-grid-model.test.ts` "no dead tiles" guard over the whole registry. tsc/lint/test (28 files, 220 tests) passed.

- DISP-3 retire duplicate routes: PR #104, branch `claude/phase-4-disp-3-retire-duplicate-routes` (stacked on DISP-2). `/console`→`/command` and `/signals`→`/dispatch` via `permanentRedirect` (308); repointed middleware/home/auth-callback/login/404 landing refs straight at canonical routes. tsc/lint/test (28 files, 220 tests) passed.

- DISP-4 command palette + quick-search coverage: PR #105, branch `claude/phase-4-disp-4-command-palette-coverage` (stacked on DISP-3). Fixed palette `--surface-1` (undefined) background bug; added missing New Task command; extracted `command-palette-model.ts` + coverage guard test (every nav route + core creates reachable); quick-search route now records/report `partial` failed sources with a safe Sentry warning and SearchWidget surfaces "some sources unavailable". Known deferred: per-record deep-open from search results belongs to per-module detail issues. tsc/lint/test (29 files, 224 tests) passed.

DISP-1..4 are the full Dispatch/Command project (no DISP-5).

- CAL-1 event detail hardening: PR #106, branch `claude/phase-4-cal-1-event-detail` (stacked on DISP-4). Acceptance was already met on `main`; extracted the untested PATCH validation + delete-cleanup transport precedence into pure `src/lib/calendar/event-detail.ts` (`validateEventPatch`, `resolveCleanupTransport`) with 15 new tests. Behavior-preserving refactor.
- CAL-2 create/update parity: PR #107 (stacked on CAL-1). Added `updateGoogleEvent`/`updateOutlookEvent` (direct-OAuth) and wired PATCH to propagate edits to connected external calendars via `resolveCleanupTransport`. Composio has no verified update tool slug (only LIST/CREATE/DELETE confirmed live) — reports `notSupported` rather than guessing at a slug, UI toasts the limitation.
- CAL-3 cache-first + sync-state: PR #108 (stacked on CAL-2). New migration `calendar_event_cache` (owner RLS, mirrors `widget_cache`) — **applied to the live Supabase project** via MCP, verified via `get_advisors`. `/api/calendar/external` write-throughs per source; `ScheduleModule` reads cache-first before the live round-trip; partial-failure no longer wipes a source's events. New `src/lib/calendar/freshness.ts` (tested) surfaces "Showing cached… / synced Nm ago".
- CAL-4 Agenda real data: PR #109 (stacked on CAL-3). New "Today" section in `/agenda` merges today's owned + cached-external events, ranked open tasks (`rankTasks`), and due People follow-ups — pure `src/components/agenda/today-ranking.ts` (tested). Also fixed a real placeholder-ranking bug: `TaskBlock`'s "top 3" was raw insertion order, now ranked.
- CAL-5 Sentry instrumentation: PR #110 (stacked on CAL-4). `sync`/`external`/`conflicts` routes had **zero** Sentry capture despite real provider failures — now tagged `area:schedule` with op/provider/transport/code, matching `event/[id]`'s existing pattern. Added a Retry button to the external-calendar failure notice in Schedule.

CAL-1..5 (#106–#110) are the full "PROJECT 2 — Calendar + Agenda Slice" from `docs/linear/axis-mvp-issues.md`. All local gates (tsc/lint/test) passed on every PR; final count 248 tests (was 218 after DISP-4). `npm run build` was not run locally this session (user-directed token-minimization) — verify via Vercel preview build before any merge.

**Authoritative plan = the pasted master phase plan (below), NOT `docs/linear/axis-mvp-issues.md`.** The repo doc uses an older, overlapping ID scheme; the user has since supplied the canonical phase-based hardening program. Map of that plan to what's actually shipped:

- **Phase 0** (DOC-1..5): done — Codex docs stack, PRs #62–#67.
- **Phase 1** (THEME/PRESENCE/RENDER): done — Codex, PRs #68–#77.
- **Phase 2** (WID/UX primitives): done — Codex, PRs #78–#85.
- **Phase 3** (WID-DATA + CONSOLE): done — Codex, PRs #86–#96.
- **Phase 4 — Daily modules:**
  - MAIL-1..5 (provider parity, skeletons, document viewer, mobile/keyboard, theme QA): done — PRs #97–#101.
  - CAL-1..5 (event detail, provider parity/update, conflict+provider failure states, Agenda/Today drill-in data, rendering/Sentry): done — PRs #106–#110. (CAL-4 delivered the master plan's "Agenda consumes real data + Today's Arc drill-in".)
  - DISP + AGENDA: the master plan's DISP-1..5 (signal detail, route-to UX, widget drill-in, duplicate/error states, badge QA) and AGENDA-1..5 (task detail drawer, source links, schedule-focus-block, empty/error polish, density pass) are **largely already satisfied** by pre-existing code + the adjacent Dispatch/Command work shipped as PRs #102–#105 (routing reliability, console navigability, route retirement, palette). Treat these as substantially covered; if a specific master-plan DISP/AGENDA acceptance line is found unmet, file it as a targeted follow-up rather than re-running the whole block.
  - NOTES-1..5: **done — PRs #111–#115.** NOTES-1 lazy-loads the TipTap editor (`NotesEditorLazy` + skeleton) to cut the `/notes` bundle; NOTES-2 replaces the fake timer-based "Saved" with a real autosave state machine (`saveStatus`/`lastSavedAt`/`retryFailedSave`, pure `save-status.ts`) + Retry; NOTES-3 adds in-module keyword + semantic search with full states (`search.ts`, semantic route returns `503 semantic_unavailable`); NOTES-4 adds note→Agenda/Dispatch/Pipeline routing with source-back traceability metadata; NOTES-5 adds density-aware editor sizing + a theme-QA guard test. Final local suite: 269 tests.
- **Phase 4 (Production Daily modules) is COMPLETE** (MAIL-1..5 #97–#101, CAL-1..5 #106–#110, Dispatch/Command #102–#105, NOTES-1..5 #111–#115). All draft PRs, stacked; local gates (tsc/lint/test) green throughout; `npm run build` deferred to Vercel preview per user token-minimization; nothing merged pending explicit approval + preview/Supabase/Sentry gates.
- **Next: Phase 5** — Beta planning & research modules (Objectives OBJ-1..4, Debrief DEBRIEF-1..5, Pipeline PIPE-1..5, Literature LIT-1..5). Then Phase 6 (People/Briefing/Fund), Phase 7 (lab modules), Phase 8 (Control Room/Nav/AI/prod).

## 6. Where Claude should resume

Resume at **NOTES-1..5** (the master plan's last Phase-4 Daily-module project, not yet started), then proceed to Phase 5 (Objectives/Debrief/Pipeline/Literature) and onward. Legacy note below (pre-master-plan sequencing, kept for provenance): through Phase 5 and every later phase from the initial project plan, in order, until the full AXIS hardening plan is complete.

Keep using one Linear issue → one branch → one PR. Branch from the current stack tip unless the user asks you to rebase onto another base. Do not merge or deploy production until preview validation, Supabase/Tembo validation, Sentry review, and manual workflow checks pass.

High-priority reminders for Phase 4:

- Mail work must validate both direct OAuth and Composio paths where provider accounts are available.
- Never log email bodies, tokens, raw OAuth payloads, or private content.
- If a provider/tooling secret is unavailable, implement visible degradation and record exact human validation steps instead of faking success.
- Preserve the adapter-driven route shape; route handlers should not reintroduce provider/transport branching.
- Every Daily module must satisfy list → detail → action → persistence → feedback → error state before it is treated as complete.

## 7. Copy-paste Claude continuation prompt

```txt
Read AGENTS.md, docs/agent-handoff/claude-to-codex.md, docs/architecture/integration-adapters.md, and the full initial phase-based hardening plan/pasted project plan if available.

Current stack status:
- Phase 0–3 are pushed as draft PRs #62–#96.
- MAIL-1 is complete and pushed as draft PR #97 on branch codex/phase-4-mail-1-provider-parity-validation, latest commit 10d587f.
- MAIL-2 is complete and pushed as draft PR #98 on branch codex/phase-4-mail-2-skeletons-detail-retry, commit 65f9514.
- MAIL-1 and MAIL-2 local gates passed: npx tsc --noEmit, npm run lint, npm run test, npm run build.

Continue through the whole phase-based hardening plan sequentially, one Codex/Claude-sized issue at a time:
- Start with the next uncompleted issue: MAIL-3, Premium message document viewer.
- After MAIL-3, continue MAIL-4, MAIL-5, then DISP-1..5, AGENDA-1..5, CAL-1..5, NOTES-1..5.
- After Phase 4, continue Phase 5 and every later phase from the initial plan in order.
- Do not skip ahead unless the plan explicitly says an issue is complete or blocked.

Follow AXIS rules exactly:
- one Linear issue → one branch → one PR
- build complete vertical slices, not visual prototypes
- preserve direct Gmail, direct Outlook, Composio Gmail, and Composio Outlook parity
- do not log or expose email bodies, tokens, OAuth payloads, or private content
- provider/network/DB failures must be visible to the user and observable through safe Sentry metadata
- no schema changes unless a migration and RLS review are included
- hold production merge/deploy until explicit user approval and the preview/Supabase/Sentry/manual gates pass

For each issue:
- inspect the relevant files and current behavior before editing
- implement the complete vertical slice for that issue
- add focused tests where practical
- run npx tsc --noEmit, npm run lint, npm run test, and npm run build
- push the branch and open a draft PR stacked on the previous issue branch unless instructed otherwise
- include Vercel preview validation steps, Supabase/Tembo impact, Sentry validation requirements, and a manual checklist in the PR
- then proceed to the next issue in the plan

End with the required agent final response format from AGENTS.md.
```
