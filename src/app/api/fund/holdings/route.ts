import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reconcileHoldings } from "@/lib/fund/reconcileHoldings";
import type { ReconciliationState } from "@/lib/fund/provenance";
import { toMajorUnitsIn } from "@/lib/fund/currency";
import {
  addMinorUnits,
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictMinorUnits,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readBoundedJsonBody } from "@/lib/http/readBoundedJsonBody";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import {
  validateAuthoritativeHoldings,
  validateCurrentConnectionBindings,
  validateHoldingCoverage,
} from "@/lib/fund/positionTruth";
import { normalizeUsEquitySymbol } from "@/lib/fund/equitySymbol";

type HoldingRow = {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  cost_basis: number;
  source: "manual" | "plaid" | "public";
  currency: string | null;
  reconciliation_state: ReconciliationState | null;
  retrieved_at: string | null;
  authority: "provider" | "manual" | "legacy_unknown";
  provider: string | null;
  provider_record_id: string | null;
  connection_id: string | null;
  generation_id: string | null;
};

/** Oldest of two nullable ISO timestamps (the conservative freshness anchor). */
function olderOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function normalizeCurrency(currency: string | null | undefined): string | null {
  return normalizeFinancialCurrency(currency, "");
}

/**
 * GET /api/fund/holdings
 *
 * Promotes the inline Supabase calls that used to live in FundModule.tsx
 * into a real route, and adds the source-aware aggregation decision #9
 * requires: rows from different sources (manual/plaid/public) are never
 * merged into one row — they're summed by symbol here for display, while
 * `rows` still exposes each source-tagged row individually.
 */
export async function GET(request: NextRequest) {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/holdings", area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("fund_holdings")
    .select("id, symbol, name, shares, cost_basis, source, authority, sort_order, currency, reconciliation_state, retrieved_at, provider, provider_record_id, connection_id, generation_id")
    .eq("user_id", user.id)
    .order("sort_order");

  if (error) return redactRouteError(error, { route: "fund/holdings", area: "fund" });
  const allRows = (data ?? []) as HoldingRow[];
  const [connectionsResult, coverageResult] = await Promise.all([
    supabase
      .from("fund_connections")
      .select("id, provider, status, authority, verified_at")
      .eq("user_id", user.id)
      .limit(33),
    supabase
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, generation_id, generation_hash")
      .eq("user_id", user.id)
      .eq("component", "holdings")
      .limit(34),
  ]);
  if (connectionsResult.error) return redactRouteError(connectionsResult.error, { route: "fund/holdings", area: "fund" });
  if (coverageResult.error) return redactRouteError(coverageResult.error, { route: "fund/holdings", area: "fund" });
  if ((connectionsResult.data ?? []).length > 32 || (coverageResult.data ?? []).length > 33) {
    return NextResponse.json(
      { error: "HOLDING_COVERAGE_UNAVAILABLE", reason: "COVERAGE_VERIFICATION_LIMIT_EXCEEDED" },
      { status: 409 },
    );
  }
  const providerRows = allRows.filter((row) => row.authority === "provider");
  const connections = connectionsResult.data ?? [];
  const applicableConnections = connections.filter((connection) =>
    (connection.provider === "plaid" || connection.provider === "public")
    && connection.status === "linked"
    && connection.authority === "provider_verified",
  );
  const providerCoverageReason = providerRows.length === 0 && applicableConnections.length === 0
    ? null
    : validateAuthoritativeHoldings(providerRows)
      ?? validateCurrentConnectionBindings(providerRows, connections)
      ?? validateHoldingCoverage(providerRows, connections, coverageResult.data ?? []);
  const providerRowsAvailable = providerCoverageReason === null;
  const rows = allRows.filter((row) =>
    row.authority === "manual" || (row.authority === "provider" && providerRowsAvailable),
  );

  // Reconcile per symbol across sources (pure, deterministic, minor-unit).
  const reconciliation = reconcileHoldings(rows);
  // Manual and provider rows are independent claims, not additive positions.
  // Prefer the verified provider generation for presentation when it exists;
  // otherwise present the explicit manual claim. Legacy rows remain excluded.
  const providerSymbols = new Set(
    rows.filter((row) => row.authority === "provider").map((row) => row.symbol),
  );
  const presentationRows = rows.filter((row) =>
    providerSymbols.has(row.symbol) ? row.authority === "provider" : row.authority === "manual",
  );

  const bySymbol = new Map<string, {
    symbol: string;
    name: string;
    shares: number;
    cost_basis: number | null;
    sources: string[];
    currencies: string[];
    currency: string | null;
    total_reason: "mixed_currency_without_fx" | "invalid_amount" | null;
    reconciliation_state: ReconciliationState | null;
    retrieved_at: string | null;
  }>();
  for (const r of presentationRows) {
    const currency = normalizeCurrency(r.currency);
    const existing = bySymbol.get(r.symbol);
    if (existing) {
      existing.shares += Number(r.shares);
      if (!existing.sources.includes(r.source)) existing.sources.push(r.source);
      if (currency && !existing.currencies.includes(currency)) existing.currencies.push(currency);
      if (currency && existing.currency === currency && existing.cost_basis !== null) {
        const left = strictMinorUnits(existing.cost_basis, currency);
        const right = strictMinorUnits(r.cost_basis, currency);
        const total = left === null || right === null ? null : addMinorUnits(left, right);
        existing.cost_basis = total === null ? null : toMajorUnitsIn(total, currency);
        if (total === null) existing.total_reason = "invalid_amount";
      } else {
        existing.cost_basis = null;
        existing.currency = null;
        existing.total_reason = "mixed_currency_without_fx";
      }
      // Aggregate freshness = the oldest constituent (most conservative).
      existing.retrieved_at = olderOf(existing.retrieved_at, r.retrieved_at);
    } else {
      const costBasisMinor = currency ? strictMinorUnits(r.cost_basis, currency) : null;
      bySymbol.set(r.symbol, {
        symbol: r.symbol,
        name: r.name,
        shares: Number(r.shares),
        cost_basis: costBasisMinor === null || !currency
          ? null
          : toMajorUnitsIn(costBasisMinor, currency),
        sources: [r.source],
        currencies: currency ? [currency] : [],
        currency,
        total_reason: costBasisMinor === null ? "invalid_amount" : null,
        reconciliation_state: reconciliation.get(r.symbol)?.state ?? null,
        retrieved_at: r.retrieved_at,
      });
    }
  }

  // Reconciliation derived during an owner read is presentation-only. Provider
  // and legacy-provider provenance can only be changed by a trusted ingest job.
  return NextResponse.json(
    {
      rows,
      aggregated: [...bySymbol.values()],
      legacyUnavailableCount: allRows.filter((row) => row.authority === "legacy_unknown").length,
      withheldProviderCount: providerRowsAvailable ? 0 : providerRows.length,
      providerUnavailable: !providerRowsAvailable,
      providerUnavailableReason: providerCoverageReason,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const identity = await resolveRouteIdentity(createClient, { route: "/api/fund/holdings", area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;

  const parsedBody = await readBoundedJsonBody(request, 8_192);
  if (!parsedBody.ok) {
    return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.value;
  const symbol = normalizeUsEquitySymbol(body.symbol);
  const currency = normalizeFinancialCurrency(body.currency, "");
  const sharesMicro = strictScaledUnits(body.shares, 1_000_000);
  const costBasisMinor = currency ? strictExactMinorUnits(body.cost_basis, currency) : null;
  const shares = sharesMicro === null ? null : scaledUnitsToDecimalString(sharesMicro, 1_000_000);
  const costBasis = currency && costBasisMinor !== null
    ? minorUnitsToDecimalString(costBasisMinor, currency)
    : null;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (
    !symbol
    || !name
    || name.length > 256
    || !currency
    || sharesMicro === null
    || sharesMicro < 0
    || !shares
    || costBasisMinor === null
    || costBasisMinor < 0
    || !costBasis
  ) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { count } = await supabase
    .from("fund_holdings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { data, error } = await supabase
    .from("fund_holdings")
    .insert({
      user_id: user.id,
      symbol,
      name,
      shares: shares as unknown as number,
      cost_basis: costBasis as unknown as number,
      source: "manual",
      authority: "manual",
      sort_order: count ?? 0,
      currency,
    })
    .select()
    .single();

  if (error) return redactRouteError(error, { route: "fund/holdings", area: "fund" });
  return NextResponse.json({ holding: data });
}
