# 13 — Convergence & Verification

**Revision:** branch `claude/axis-system-redesign-7986vb` (PR #190) · **Date:** 2026-07-14

> Historical snapshot. Wave 15.1 (2026-07-16) supersedes the WebAuthn and
> lifecycle loose ends below: approval step-up is now bound to an exact
> one-time WebAuthn ceremony and counter CAS; passkey login mints a fresh
> server-side session without stored refresh tokens; browser mutation authority
> is removed from passkeys, challenges, approvals, and trusted run/step audit
> rows; task provenance and routine steps are claim-fenced; renewable leases,
> stale-worker quarantine, and lost-response recovery are locally verified.
> Automated Chromium virtual-authenticator coverage passes. Only GitHub is
> operational. Production Supabase, Vercel, Sentry, Render, and OpenAI remain
> explicitly `BLOCKED`; see `docs/axis-redesign/15-completion-matrix.md` for
> missing access, exact checks, and human owners. Physical-authenticator testing
> and independent human security sign-off remain open.

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
| Vercel preview | **HISTORICAL ONLY** — green on prior heads; current Wave 15.1/15.2 preview validation is `BLOCKED` without an authorized Vercel session or preview bypass |
| Migrations | **HISTORICAL ONLY** — older migrations were applied on a live project; `202607161000_lifecycle_claims.sql` and `202607161200_vector_arcade_persistence.sql` remain production-`BLOCKED` without Supabase DDL authority |

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
- **Not started this program:** 7 (workspace shell redesign), 10 (integration rearchitecture), 11 (performance), 14 (CI/CD gates). Existing systems retained.

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
