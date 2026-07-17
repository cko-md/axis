# Axis System Redesign — Program Charter

> Status: **production-gate validation** · Owner: redesign program · Branch: `codex/phase9-resume-executor` (PR #195)
> Baseline commit: `f478cde` · Established: 2026-07-13 · Current state: `.claude/axis-redesign/PROGRAM_STATE.json`

## 1. What this program is

A bottom-up, evidence-driven modernization of Axis that selectively adopts the
strongest ideas from **Macro** (entity-centric workspace, backlinks, split
panes, command palette, unified search, local-first responsiveness) and **Town**
(persistent assistant identity, Need-to-Know signal queue, shared Tasks,
Routines, Skills, memory, per-tool permissions, durable resumable runs, approval
queue, cost visibility) — filtered through an Axis-specific **financial safety
kernel** (provenance, deterministic calculation, action permissions, audit,
partitioned provider data).

The goal is a coherent, original personal financial operating system — not a
visual imitation of either reference product.

## 2. Governance reconciliation (important)

This program runs **inside** an existing, mature codebase with its own binding
rules in `AGENTS.md`. The owner-authorized System Redesign Override in §2a
permits the coordinated cross-module waves recorded here; every security,
financial-safety, migration, observability, and green-gate rule remains binding:

- **No broad unrelated refactors.** Change only what a wave requires.
- **One coherent change → one branch → one PR.** Ship complete vertical slices,
  never render-only prototypes.
- **Preserve existing behavior** unless a wave explicitly changes it; reuse
  existing functions rather than reimplementing.
- **No schema change without a migration + RLS review.**
- **No secrets in code/logs/PRs.** Log safe metadata only.

Consequence: the redesign is executed as a **sequence of small, tested,
independently reviewable waves** behind a strangler pattern — not a rewrite. Each
wave is additive-first and removes legacy paths only after replacement is
verified.

## 3. Baseline (revision `f478cde`, deps installed via `npm ci`)

| Gate            | Command              | Result                         |
| --------------- | -------------------- | ------------------------------ |
| Typecheck       | `npx tsc --noEmit`   | pass                           |
| Lint            | `npm run lint`       | 0 errors, 7 warnings (pre-existing `react-hooks/exhaustive-deps`) |
| Unit tests      | `npm run test`       | 67 files, 416 tests pass       |
| Stack           | —                    | Next.js 15 (App Router), React 19, TS 5.8, Supabase (Postgres+RLS), Tailwind v4, Vitest, Playwright, Sentry |

Any new failure introduced by a wave is distinguishable from this baseline.

## 4. Operating loop (the product thesis)

```
Observe → Normalize → Determine significance → Surface a signal / create a task
→ Gather context → Calculate deterministically → Reason where judgment is needed
→ Propose → Approve where required → Execute within permissions → Verify
→ Record evidence & provenance → Learn only through reviewable updates
```

## 5. Non-negotiable safety rules (financial kernel)

- Deterministic, typed code owns all arithmetic (returns, allocation,
  reconciliation, currency, fees, tax lots). AI explains; it never authorizes or
  computes the authoritative number.
- No autonomous financial execution by default. External communication and
  financial execution require explicit approval (+ step-up for execution).
- External content (email, web, documents, third-party APIs) is untrusted data
  and can never grant permission or authorize an action.
- Provider data stays partitioned (bank / brokerage / tax / personal) until
  same-owner, compatible-currency, fresh, permitted reasoning is established.
- Money is never stored/aggregated as binary float where correctness matters.

## 6. Phase map & where we are

| Phase | Name | State |
| ----- | ---- | ----- |
| 0 | Program initialization + baseline | done |
| 1–3 | Audit, product synthesis, target architecture | substantial; source-of-truth documents and ADRs complete for the implemented scope |
| 4 | Financial domain & data foundation | complete for the documented redesign scope |
| 5 | Security kernel | core complete; independent sign-off and a manual hardware-authenticator ceremony remain external gates |
| 6 | Design system | complete |
| 7 | Workspace shell | implemented; preview validation remains |
| 8 | Core modules | complete for the documented redesign scope |
| 9 | Agent runtime | implementation complete; final production gates remain |
| 10 | Integration rearchitecture | code/architecture scope complete; unavailable live-provider paths remain external gates |
| 11 | Performance | scoped profiling and route budgets complete |
| 12 | Testing | automated system complete; current PR clean-runner and browser evidence remain |
| 13 | Observability | instrumentation/runbook complete; preview-window Sentry evidence and operational alert setup remain |
| 14 | CI/CD and production readiness | delivery implementation complete; preview, merge/deploy authorization, and post-deploy contract migration remain |

The machine-readable state is authoritative for exact revisions, migrations,
test counts, and remaining production gates:
`.claude/axis-redesign/PROGRAM_STATE.json`.

## 7. Resume protocol for future sessions

1. Read `.claude/axis-redesign/PROGRAM_STATE.json` for the last verified revision,
   current phase/wave, and open defects.
2. `git log --oneline` since `revision_reviewed`; only re-open files whose hashes
   or dependencies changed.
3. Re-run targeted tests before full suites.
4. Continue from the next dependency-ordered wave; do not repeat completed audits.

The full method is packaged as a reusable skill: `.claude/skills/axis-system-redesign/`.
