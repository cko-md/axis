# ADR 0001 — Deterministic money via integer minor units

- Status: accepted
- Date: 2026-07-13
- Wave: Phase 4.1

## Context

Fund aggregates monetary amounts as IEEE-754 floats (`Number(x)` + `reduce(+)` +
`.toFixed()`) across net worth, liabilities, recurring, and cashflow (see
`01-current-state-audit.md`, FIN-001). Float addition drifts
(`0.1 + 0.2 === 0.30000000000000004`), producing off-by-a-cent totals in
user-facing financial roll-ups. The program's safety kernel requires
deterministic, typed arithmetic for all financial values.

## Options considered

1. **Add a `Decimal`/`big.js` dependency.** Precise, but adds a runtime dep and a
   new value type that would ripple through many components and serialization
   boundaries — a broad refactor, which `AGENTS.md` forbids without cause.
2. **Integer minor units (cents) in a pure, dependency-free helper module.**
   Amounts stay plain `number` at rest and at the display boundary; only
   aggregation converts to integer cents and back. Additive; adoptable one call
   site at a time.
3. **Do nothing.** Leaves a known correctness defect in financial totals.

## Decision

Option 2. Add `src/lib/fund/money.ts` with `toMinorUnits`, `toMajorUnits`,
`parseMoney`, `sumMoney`, `sumBy`. Round half away from zero at the cent.
Non-finite/invalid input → 0 (preserves the existing `safeMoney` contract).

## Rationale

Zero new dependencies; no new pervasive value type; each aggregation site can
migrate independently in its own small PR (strangler pattern). Correctness is
locked in by financial-invariant unit tests.

## Consequences

- `safeMoney` now rounds to the cent (previously passed sub-cent floats through).
  Covered behavior is unchanged; sub-cent inputs are now correctly rounded.
- Remaining `reduce(+ Number(...))` sites in `src/components/fund/*` and
  `src/lib/fund/*` are follow-up adoption waves — one component per PR.
- Assumes 100 minor units per major unit (USD/EUR/GBP). Zero-decimal or
  three-decimal currencies need a per-currency minor-unit table before
  multi-currency work; noted for the currency wave.

## Reversal cost

Low. The module is additive and pure; call sites that adopt it can revert
individually.
