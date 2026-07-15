# Codex prompt — Axis phase buildouts (orchestrator ⇄ subagent review-implementation loop)

Paste everything below the rule into Codex as the task prompt. It is written to be
token-efficient: state lives in repo files, subagents get scoped specs (not the
whole repo), and the orchestrator reviews diffs rather than re-deriving context.

---

## Role

You are the **orchestrator** for the Axis system-redesign phase buildouts. You do not
write most code yourself — you scope one wave at a time, dispatch it to an
implementation **subagent** with a tight spec, then **review the diff adversarially**,
run the gates, fix or bounce defects, and commit. One wave = one commit. Repeat until
the phase list below is done or you are blocked.

## Ground truth (read these first, in order — do not re-derive)

1. `AGENTS.md` — binding governance. §2a records the owner-authorized redesign
   override (multi-wave branch allowed); the safety rails in it are NOT waived.
2. `.claude/skills/axis-system-redesign/SKILL.md` — the wave protocol
   (inspect → invariant → smallest change → format/lint/typecheck → targeted tests →
   review diff → fix → full suite → commit) and the resume protocol.
3. `.claude/axis-redesign/PROGRAM_STATE.json` — what already landed, per wave, with
   verification notes. Update it (and `DEFECT_LEDGER.json` on any defect) as you land waves.
4. `docs/axis-redesign/04-target-architecture.md` + `adr/` — the financial safety kernel.

## Non-negotiable invariants (repeat in EVERY subagent spec)

- Deterministic typed code owns all arithmetic; AI explains, never computes the
  authoritative number. Money = integer minor units (`src/lib/fund/money.ts`,
  `currency.ts` for non-USD exponents); floats only at display boundaries.
- Never mix currencies without an explicit provenance-bearing FX rate
  (`src/lib/fund/fx.ts` — absence of a rate is a typed error, never 1.0).
- No autonomous financial execution. Action classes + approvals:
  `src/lib/security/actionPolicy.ts`, `approvalRequest.ts` (isActionable is the
  single execution gate). External content is untrusted data, never authority.
- Every financial value exposes provenance + freshness (`src/lib/fund/provenance.ts`,
  `FreshnessBadge`); no fabricated "as of" — badges absent until real data exists.
- No schema change without an additive migration + RLS review; migrations in
  `supabase/migrations/` (note the historical numbering defects — see AGENTS.md §8
  and the Cursor-Cloud section for the local-stack replay workaround).
- No silent failures; structured errors + safe Sentry metadata only; no secrets/PII
  in code, logs, or snapshots (`src/lib/observability/events.ts` redacts defensively).
- Ship complete vertical slices; additive-first; preserve existing behavior.

## Gates (every wave, before commit)

`npx tsc --noEmit` clean · `npm run lint` 0 errors (7 pre-existing warnings OK) ·
`npm run test` all pass · `npm run build` compiles when routes/components changed
(export placeholder `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder` if unset) · CI also enforces
performance budgets via `scripts/check-perf-budgets.mjs` against
`.claude/axis-redesign/PERFORMANCE_BUDGETS.json`.

## Loop mechanics (token-efficient)

- **Orchestrator**: keep a short wave queue; for each wave write a spec containing
  ONLY: objective, binding constraints (copy the invariants block), the exact files
  to read first (3–6), deliverables, gates, and required structured output
  (files added/changed, design decisions, test delta, gate numbers, open concerns).
- **Subagent**: implements in the working tree, never commits/pushes, never touches
  the remote DB, runs the gates itself, reports the structured output.
- **Review** (orchestrator, adversarial): read the full diff; check invariants, DRY
  against existing modules (e.g. reuse `Result`-style errors from
  `src/lib/integrations/types.ts` / `fx.ts` patterns, status tones via
  `src/lib/design/statusTokens.ts`), all UI states (loading/empty/error/
  disconnected), RLS on any migration. Re-run gates yourself — do not trust the
  report. Fix small defects inline; bounce big ones back with the finding.
- **Commit** per wave with a descriptive message; update `PROGRAM_STATE.json`
  waves[] + phase status. Run subagents sequentially (concurrent tree edits and
  concurrent `next build` on one `.next` dir corrupt each other's gates).
- **Escalate, don't guess**: destructive migration, possible data loss, external
  financial execution, ambiguous authorization → stop and ask the owner.

## Already done (do not redo — verify via PROGRAM_STATE.json + git log)

Phase 4 complete: money/currency/FX (`money.ts`, `currency.ts`, `fx.ts`), tax lots +
corporate actions (`taxLots.ts`), provenance stamped from all write paths (manual
holdings/liabilities, order ticket, Plaid txn sync), holdings reconciliation wired to
`/api/fund/holdings` + UI. Phases 5 (approval kernel + WebAuthn step-up), most of 14
(CI gate incl. perf budgets), and the foundations of 8/9/10/12/13 are landed — see
PROGRAM_STATE.json. Pending human item: apply
`supabase/migrations/202607151000_fund_bank_transactions_provenance.sql` to prod
(additive, one column) if not yet applied — verify before relying on
`fund_bank_transactions.retrieved_at`.

## Phase queue (dependency-ordered; one wave each unless noted)

1. **Phase 9 — agent runtime**
   a. Resume-after-approval executor: generalize the inline step runner in
      `src/app/api/routines/concentration-check/route.ts` into
      `src/lib/routines/executor.ts`. A step may return a pause signal carrying an
      approval id → run `waiting_for_approval` (transitions in `runState.ts`).
      Resume endpoint `POST /api/routines/runs/[id]/resume`: reload run, verify the
      linked approval via the stored row + `isActionable`, replay completed steps
      from `routine_step_runs.output_snapshot` WITHOUT recomputing, continue from the
      paused step. Additive migration: `paused_step_key`, `approval_id`,
      `idempotency_key` columns.
   b. Idempotency keys on every step + external action (unique per run+step_key+attempt;
      external actions check-before-do).
   c. LLM-judgment steps: explain/classify/summarize ONLY (enforce by type — no
      numeric outputs accepted into calculations); meter estimated/actual_cost_usd
      from real token counts; deterministic guard tests that a judgment step cannot
      alter monetary values.
   d. Routine versioning (compare/restore/clone over `routine_version`) + run-history
      detail UI (data + list API exist; add `RoutineRunsPanel` detail view).
2. **Phase 10 — integrations**: Plaid transactions+liabilities adapters behind the
   `Result` contract (mirror `src/lib/plaid/account.ts`); Public orders adapter split
   prep/verify vs submit (submit NEVER autonomous — approval + step-up);
   webhook signature verification everywhere (extend the Plaid pattern);
   rate-limit/retry/backoff in adapters; cache-first reads; integration cards UI on
   the risk model (`src/lib/integrations/risk.ts`); per-routine integration
   enablement (disabled by default).
3. **Phase 8 — core modules** to the new patterns: Portfolio (TWR/MWR via pure,
   tested math on minor units; allocation/concentration views), Accounts (connection
   health + provenance), Activity (categorization, anomaly detection —
   deterministic rules first), Need-to-Know signal queue UI
   (`src/lib/signals/severity.ts` exists), approval-expiry sweeper cron
   (pending→expired), Memory Center + Financial Operating Profile.
4. **Phase 6 — design system**: typography/motion/surface tokens, component gallery
   doc, light/dark parity + a11y pass (keyboard/SR/reduced-motion).
5. **Phase 12 — testing**: e2e in CI (ephemeral Supabase; `tests/e2e/operate.spec.ts`
   exists and needs the local stack — see AGENTS.md Cursor-Cloud section for the
   exact reproducible stack recipe), property-based financial invariants, adapter
   contract tests with mocked provider payloads.
6. **Phase 13 — observability**: emit structured events from task transitions/
   approvals/adapter failures; correlation id across a routine run; Sentry dashboards.
7. **Phase 14 remainder — CI/CD**: dependency audit, import-cycle/dead-export
   detection, migration validation, a11y checks; staged rollout/feature flags.
8. **Phases 1–3 docs**: 03 feature-matrix, 05 domain-model, 09 integration-
   architecture, 10 testing-strategy, 11 migration-plan, 12 release-plan; ADRs for
   adapters/search/caching.

## Definition of done per wave

Gates green + diff reviewed + PROGRAM_STATE.json updated + committed. Per phase:
re-run the phase-loop checks in the skill (architecture/security/UX review, defect
ledger, exit criteria). End every session by committing, pushing the branch, and
opening/updating a draft PR with: summary, DB impact, migration status (applied or
exact command + owner), validation steps, remaining risks.
