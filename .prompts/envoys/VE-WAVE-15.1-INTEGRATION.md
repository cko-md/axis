# VE-WAVE-15.1-INTEGRATION

## Objective

Integrate current `origin/main` and canonical retry-safe approval-resume repair
into the Phase 9-derived program branch without losing either foundation. Then
close `PREF-001`, `RUN-002`, and `TASK-002`: preserve preference envelope/timezone
state, prevent writes after failed remote load, and make task/approval lifecycle
changes reject stale concurrent claims.

## Exact files to read

- `src/components/theme/ThemeProvider.tsx`
- `src/lib/theme/interface-settings.ts`
- `src/lib/dates.ts`
- `src/components/debrief/DebriefModule.tsx`
- `src/app/api/routines/runs/[id]/resume/route.ts`
- `src/lib/routines/executor.ts`
- `src/lib/routines/executor.test.ts`
- `src/app/api/agent-tasks/[id]/route.ts`
- `src/app/api/approvals/[id]/route.ts`
- matching route tests and Supabase database types
- `c2de9308` complete diff
- `origin/main` merge diff and auto-merged paths

## Deliverables

1. One merge commit containing current `origin/main`, patch-equivalent
   `c2de9308`, and Wave 15.1 hardening.
2. Theme preference parser/persistence that:
   - carries the browser IANA timezone;
   - preserves unknown outer-envelope fields;
   - writes only after successful remote read for authenticated users;
   - stays local and visibly errored after failed read;
   - does not echo-save immediately after hydrating remote state.
3. Retry-safe routine resume and single-claim execution from `c2de9308`.
4. Expected-state compare-and-set for task and approval decisions/execution,
   returning `409` on stale state.
5. Visible/observable secondary-write errors; no swallowed activity/event failure.
6. Focused regression tests.
7. Updated state, defects, completion matrix, and wave log.

## Binding constraints

- Preserve all Phase 9 files and current-main fixes.
- Do not apply `3718c308`; it carries unrelated calendar rescue ancestry. Use
  only patch-equivalent `c2de9308`.
- Preserve Debrief local-day and reminder-update safeguards.
- Never weaken approval completeness, expiry, step-up, or no-autonomous-financial-
  execution gates.
- No preference write after a failed authenticated remote read.
- No raw preference/task/approval private content in Sentry.
- Expected stale conflicts are `409`, not captured exceptions.
- No schema change unless route-level compare-and-set cannot satisfy integrity;
  if schema changes, add migration, fixed grants, RLS review, types, and tests.
- No production data mutation in this wave.

## Tests

- preference parsing, unknown-field/timezone preservation, successful-read gate,
  failed-load no-write, and remote-hydration no-echo tests;
- routine executor single-claim and transient-failure retry tests;
- concurrent task transition and approval approve/deny/execute stale-state tests;
- current-main date/Debrief focused tests;
- `npx tsc --noEmit`;
- `npm run lint`;
- `npm run test`;
- `npm run build`;
- per-route and total bundle budgets.

## Required structured output

- files changed;
- merge parents and rescue patch provenance;
- invariants preserved;
- defects fixed;
- database impact;
- focused/full gate results;
- browser impact and manual checks;
- remaining risks.
