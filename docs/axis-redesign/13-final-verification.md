# 13 — Convergence & Verification

**Revision:** branch `claude/axis-system-redesign-7986vb` (PR #190) · **Date:** 2026-07-14

> Historical snapshot: this document records the original PR #190 convergence
> point. The redesign has since advanced through Phases 6–14 on
> `codex/phase9-resume-executor` (PR #195). The authoritative current revision,
> gate evidence, hosted migration state, and remaining external checks are in
> `.claude/axis-redesign/PROGRAM_STATE.json`; release ordering and rollback are
> in `12-release-plan.md`. Do not use the historical counts or loose ends below
> as the current production-readiness claim.

## Current PR #195 evidence

Reviewed application revision: `89705a4a` on
`codex/phase9-resume-executor`.

| Gate | Current result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors / 0 warnings |
| `npm run test` | 1072 pass / 166 files |
| `npm run release:validate` | pass; expansion and contract checksums/read-backs pinned |
| `npm run build` | 163 pages; 182/182 route budgets; 4017/4400 KB aggregate static JS |
| Public production-mode Playwright | 13/13 pass |
| Authenticated production-mode Playwright | 14/14 pass including auth setup |
| GitHub clean runner | run `29531283377` passed verify, public, and fresh-Supabase authenticated jobs |
| Vercel preview | `dpl_AgKR1xhhQc4XyqSi4hteZ2ehVW5d` Ready; public 200, guarded APIs 401, unknown 404, preview-local login redirect, 0 queried 5xx/error logs |
| Sentry | exact release `89705a4a…` exists; Issues query returned 403, so regression review is blocked rather than passed |
| Hosted Supabase | expansion migrations applied/read back; contract migration intentionally pending compatible production deploy |

The prior preview exposed an origin-isolation defect: same-app auth redirects
used the configured production origin. Revision `89705a4a` separates canonical
OAuth callback origins from request-local redirects, preserves loopback hosts,
and rejects crafted Host values. The exact new preview proves the redirect stays
on its own deployment. Protected authenticated preview workflows and Sentry
Issues review still require authorized operators before production merge.

This is an honest convergence assessment, not a claim that the full 14-phase
program in the master prompt is finished. That prompt describes a multi-quarter
rewrite. What this branch delivers is a **coherent, green, end-to-end vertical of
the operating loop** — observe → significance → task → approval → durable run —
on a deterministic financial-safety kernel, all additive and behind existing
behavior.

## Gate status (this revision)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors (7 pre-existing warnings, untouched files) |
| `npx vitest run` | 524 pass / 79 files |
| `npm run build` | compiles (static export of some existing pages needs Supabase env not present in the CI sandbox) |
| Vercel preview | green on prior heads |
| Migrations | applied + verified on the live project; no RLS lint on any new table |

## The operating loop, end to end

1. **Observe / significance** — `reviewConcentration` (deterministic, tested) over real `fund_holdings`.
2. **Task** — the concentration routine creates a `queued` agent-Task per breach (idempotent).
3. **Durable run** — every trigger records a `routine_runs` row + `routine_step_runs` snapshots (§15.5).
4. **Task lifecycle** — `/tasks` workbench; server enforces `canTransition` (illegal → 409).
5. **Approval** — `/approvals` shows full §11.3 scope; `isActionable`-gated execute; **no autonomous financial execution**; step-up required for financial/destructive classes.
6. **Record** — append-only activity/audit tables; no-delete posture.

## Phase-by-phase (honest)

See `.claude/axis-redesign/PROGRAM_STATE.json` `phases` for the authoritative
map. Summary:

- **Done / core done:** 0 (init), 4 (financial domain core), 5 (security kernel), 9 (durable runtime core).
- **Substantial:** 1 (audit), 2 (synthesis), 3 (target arch — ADR-0001, more to write).
- **Partial:** 6 (design system — freshness primitive only), 8 (core modules — Tasks only), 12 (testing — units, no new e2e), 13 (observability — error codes only).
- **Implemented after this original assessment; external production gate still pending:** 7 (canonical typed entities, owner-scoped references/usage, unified search and previews/backlinks, URL-restorable split panes with pane-local history, and scoped workspace commands).
- **Not started in this original revision:** 10 (integration rearchitecture), 11 (performance), 14 (CI/CD gates). Existing systems retained.

## Known loose ends (tracked, not hidden)

- Step-up authentication is **modeled** (a timestamp column + gate) but not yet bound to a real WebAuthn challenge.
- The Approvals queue is **empty by design** until a real execution skill produces genuine order details — no fabricated trade approvals.
- Interactive auth'd click-through of `/tasks` and `/approvals` needs the local Supabase stack; verified here via compile + tsc + lint + unit tests + live DB constraint/policy read-back.
- `database.types.ts` new tables were added by **targeted edits**, not a full regen (the file is a reference artifact, not wired into the client).

## Safety posture (enforced, unwaived)

Deterministic typed code owns all financial math; no autonomous financial
execution; untrusted external content never authorizes an action; owner-scoped
RLS on every new table; no secrets/private content logged. Recorded in
`AGENTS.md §2a` and the security model docs.
