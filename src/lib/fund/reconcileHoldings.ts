/**
 * Per-symbol reconciliation for source-tagged fund holdings.
 *
 * `fund_holdings` rows are tagged with the provider that supplied them
 * ('manual' | 'plaid' | 'public'). When the same symbol is held via more than
 * one source, those sources are independent claims about the same position and
 * should agree — this module compares them and classifies the result into the
 * domain's {@link ReconciliationState} (see provenance.ts).
 *
 * Design decisions (kernel: honest state, deterministic minor-unit arithmetic,
 * never fabricate a comparison that did not happen):
 *
 *  - SINGLE SOURCE → `null` (not reconciled), NOT 'partial'. The domain's
 *    'partial' means "a reconciliation was attempted and exactly one of two
 *    sources showed up". A symbol held by only one provider has no expected
 *    counterpart — nothing was reconciled — so the honest state is the untouched
 *    NULL column. Emitting 'partial' would light a UI indicator implying data is
 *    incomplete / awaiting a second feed, which is misleading. We therefore only
 *    ever assign a state when ≥2 sources actually claim the symbol.
 *
 *  - MULTI-CURRENCY → 'pending' (explicit skip). Cost bases in different
 *    currencies cannot be compared without an FX conversion, and converting
 *    would inject FX-rate provenance and rounding into a reconciliation that is
 *    supposed to be exact. Reusing money.ts's no-mixing rule, when a symbol's
 *    rows span more than one currency we do not compare across them; the pair is
 *    'pending' (awaiting reconciliation) rather than a fabricated match/conflict.
 *
 *  - TOLERANCE = 0 (cent-exact). No documented provider rounding reason exists
 *    for cost basis, so two sources must agree to the cent. If a real provider
 *    rounding quirk is later documented, raise the tolerance in ONE place here.
 *
 * Pure and dependency-free (no I/O): arithmetic is integer minor units via
 * money.ts, so results are deterministic and unit-testable as an invariant.
 */

import { toMinorUnits } from "./money";
import { reconcileAmount, type ReconciliationState } from "./provenance";

/** Cent-exact: cost basis from two sources must agree to the penny. */
const RECONCILE_TOLERANCE_MINOR = 0;

/** Default currency when a row omits it (matches the DB column default). */
const DEFAULT_CURRENCY = "USD";

/** A source-tagged holding row, as returned by the holdings query. */
export type ReconcilableHolding = {
  symbol: string;
  source: string;
  cost_basis: number | string | null | undefined;
  /** ISO-4217 code; defaults to USD when absent (DB column default). */
  currency?: string | null;
};

/** Summed cost basis for one source of a symbol, in both units. */
export type SourceTotal = {
  source: string;
  /** Integer minor units (cents) — the value comparisons are made on. */
  totalMinor: number;
  /** Major units (dollars), for display/debugging. */
  total: number;
  currency: string;
};

/** Reconciliation outcome for one symbol. */
export type SymbolReconciliation = {
  symbol: string;
  /**
   * The reconciliation state, or `null` when the symbol was NOT reconciled
   * (single source with no expected counterpart). `null` means "leave the
   * column untouched / show no indicator" — an honest absence, not a state.
   */
  state: ReconciliationState | null;
  /** Per-source summed cost basis used for the comparison. */
  sourceTotals: SourceTotal[];
  /** The shared currency, or `null` when rows span multiple currencies. */
  currency: string | null;
};

function normalizeCurrency(currency: string | null | undefined): string {
  const c = (currency ?? "").trim().toUpperCase();
  return c === "" ? DEFAULT_CURRENCY : c;
}

/**
 * Reconcile source-tagged holdings, grouped by symbol.
 *
 * @returns a Map keyed by symbol (insertion order = first-seen order) of the
 *   per-symbol {@link SymbolReconciliation}.
 */
export function reconcileHoldings(
  rows: readonly ReconcilableHolding[],
): Map<string, SymbolReconciliation> {
  // symbol -> source -> { minor total, currency (first seen for that source) }
  const bySymbol = new Map<string, Map<string, { totalMinor: number; currency: string }>>();
  for (const row of rows) {
    const symbol = row.symbol;
    let sources = bySymbol.get(symbol);
    if (!sources) {
      sources = new Map();
      bySymbol.set(symbol, sources);
    }
    const currency = normalizeCurrency(row.currency);
    const existing = sources.get(row.source);
    if (existing) {
      existing.totalMinor += toMinorUnits(row.cost_basis);
      // A single source split across currencies is itself a mixed-currency
      // situation; record the divergence by marking the source's currency.
      if (existing.currency !== currency) existing.currency = "__MIXED__";
    } else {
      sources.set(row.source, { totalMinor: toMinorUnits(row.cost_basis), currency });
    }
  }

  const result = new Map<string, SymbolReconciliation>();
  for (const [symbol, sources] of bySymbol) {
    const sourceTotals: SourceTotal[] = [...sources.entries()].map(([source, v]) => ({
      source,
      totalMinor: v.totalMinor,
      total: v.totalMinor / 100,
      currency: v.currency,
    }));

    const currencies = new Set(sourceTotals.map((s) => s.currency));
    const mixedCurrency = currencies.size > 1 || currencies.has("__MIXED__");
    const sharedCurrency = mixedCurrency ? null : (sourceTotals[0]?.currency ?? DEFAULT_CURRENCY);

    let state: ReconciliationState | null;
    if (mixedCurrency) {
      // No-mixing rule: cannot compare across currencies without FX.
      state = "pending";
    } else if (sourceTotals.length < 2) {
      // Single source, no counterpart to reconcile against — leave untouched.
      state = null;
    } else {
      // ≥2 sources, one currency: compare each against the first. With a
      // zero tolerance, equality is transitive, so "any pair conflicts"
      // ⟺ "some source differs from the reference".
      const reference = sourceTotals[0];
      let conflicting = false;
      for (let i = 1; i < sourceTotals.length; i++) {
        const s = reconcileAmount(
          reference.total,
          sourceTotals[i].total,
          RECONCILE_TOLERANCE_MINOR,
        );
        if (s === "conflicting") {
          conflicting = true;
          break;
        }
      }
      state = conflicting ? "conflicting" : "matched";
    }

    result.set(symbol, { symbol, state, sourceTotals, currency: sharedCurrency });
  }

  return result;
}
