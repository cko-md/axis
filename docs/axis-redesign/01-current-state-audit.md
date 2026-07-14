# 01 — Current-State Audit (revision `f478cde`)

Grounded in direct inspection of the repository. Evidence is file paths; line
ranges are given where a specific claim depends on them.

## 1. What Axis actually is today

A single-user personal operating system (not a standalone fintech app). One
Next.js 15 App Router dashboard unifies many life domains behind a shared
`AppShell` + sidebar. Finance ("Fund") is one module among many. This differs
from the master prompt's finance-first framing; the redesign therefore treats
the **Fund module + cross-cutting agent/workspace layer** as the primary surface
for Macro/Town ideas, while respecting the existing multi-module product.

### Modules present (`src/app/*`, `src/components/*`, `src/lib/*`)

`agenda`, `atelier`, `briefing`, `console`, `control-room`, `debrief`,
`dispatch`, `fund`, `library`, `listening-vault`, `literature`, `mail`, `notes`,
`objectives`, `people`, `pipeline`, `schedule`, `signals`, `supper-club`,
`vitality`, plus `auth`, `command`, `search`, `nav`, `widgets`, `layout`,
`motion-primitives`, `theme`, `ui`.

Notably already present and directly relevant to the Macro/Town synthesis:
- **`command/` + `search/`** — command palette and unified search primitives.
- **`signals/`** — a signal surface (maps to Town "Need to Know").
- **`widgets/` + `docs/architecture/widget-cache.md` + `widget-motion.md`** — an
  existing widget + cache + motion system.
- **`briefing/` / `debrief/`** — assistant briefing surfaces.
- **`objectives/` / `pipeline/`** — task/work-tracking surfaces.

### Fund (finance) sub-surfaces (`src/app/fund/*`)

`page`, `net-worth`, `investing`, `spending`, `cashflow`, `forecasting`,
`watchlist`, `market`, `advisor`, `position/[symbol]`. Backed by
`src/lib/fund/*` (Plaid sync, finance narrator jobs/context, daily jobs, Make
notifications, Plaid tokens) and `src/components/fund/*` modules.

## 2. Financial-correctness findings

| ID       | Severity | Finding | Evidence |
| -------- | -------- | ------- | -------- |
| FIN-001  | medium   | Money is parsed and aggregated as IEEE-754 float throughout Fund (`Number(x)` + `reduce((s,a)=>s+a,0)` + `.toFixed()`). Large roll-ups (net worth, liabilities, recurring, cashflow) can drift by a cent. | `OverviewModule.tsx:19,47`, `FundNetWorthModule.tsx:16`, `FundLiabilities.tsx:71`, `FundRecurringList.tsx:52`, `FundCashflowModule.tsx:45-54`, `financeDailyJobs.ts:21,74`, `financeNarratorContext.ts:11` |
| FIN-002  | low      | `safeMoney` accepted sub-cent floats verbatim (no rounding to the currency's minor unit). | `financeNarratorContext.ts` (pre-wave) |

**Wave 4.1 (landed):** added `src/lib/fund/money.ts` — deterministic
minor-unit (cent) conversion + exact `sumMoney`/`sumBy`, with financial-invariant
tests (`money.test.ts`). Routed `safeMoney` through it (behavior-preserving on
covered cases; now cent-rounded). Remaining aggregation call sites are candidates
for follow-up adoption waves (additive, one component per PR).

## 3. Quality baseline

- Typecheck clean; 416 unit tests pass across 67 files; lint 0 errors / 7
  pre-existing hook-dependency warnings. Playwright configured (`public` +
  `authenticated` projects). Sentry wired (`sentry.*.config.ts`,
  `instrumentation-client.ts`).
- Rich existing audit corpus in `docs/audits/*` (platform audit, security audit
  2026-06-28, current-state 2026-06-30, latency audit) and `docs/design/*` — the
  redesign should build on these, not duplicate them.

## 4. Keep / adapt / defer (high level)

- **Keep:** command palette, unified search, widget/cache/motion system, signals
  surface, module shell, Supabase RLS model, existing design + audit docs.
- **Adapt toward Town:** `signals/` → severity-tiered Need-to-Know with
  dedup/resolution; `objectives`/`pipeline` → durable Task state machine;
  `briefing`/`debrief` → Routine runs with history; add Skills + approval queue +
  per-tool permissions + cost metering.
- **Adapt toward Macro:** promote typed entities + backlinks + hover previews +
  split panes on top of the existing search/command foundation.
- **Foundational (in progress):** deterministic finance domain (money precision
  landed; provenance, idempotency, reconciliation states next).

## 5. Open risks

- Master prompt assumes a finance-first app; real app is broader — scope every
  wave to a single module/PR per `AGENTS.md`.
- Schema/provenance changes require migrations + RLS review (blocked on Supabase
  target availability; record the check in the PR when tooling is absent).
