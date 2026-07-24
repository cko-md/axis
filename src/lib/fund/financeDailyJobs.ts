import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { decrypt } from "@/lib/crypto";
import { getPlaidCreds } from "@/app/api/plaid/_lib";
import { fetchSnapshot, getPolygonApiKey } from "@/lib/massive/client";
import { notifyViaMake } from "@/lib/fund/notifyViaMake";
import { FRESHNESS_SLAS, classifyFreshness } from "@/lib/fund/provenance";
import { MICRO_SHARES_PER_SHARE } from "@/lib/fund/taxLots";
import {
  addMinorUnits,
  completeProviderSnapshot,
  financialInput,
  financialInputMinor,
  minorUnitsToDecimalString,
  multiplyScaledQuantityByDecimalPrice,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
  strictMinorUnits,
  strictScaledUnits,
  type FinancialInput,
  type FinancialSnapshotOutcome,
} from "@/lib/fund/financialTruth";
import { noNotifications, notificationOutcome, type FinanceNotificationOutcome } from "@/lib/fund/notificationOutcome";
import {
  fetchPortfolioQuotes,
  MAX_PORTFOLIO_QUOTE_SYMBOLS,
  validateAuthoritativeHoldings,
  validateHoldingCoverage,
} from "@/lib/fund/positionTruth";
import {
  coverageLineage,
  detectedRecurringMatchesCoverage,
  readCompleteTransactionRows,
  readCompleteTransactionCoverage,
  TRANSACTION_HISTORY_DAYS,
} from "@/lib/fund/transactionCoverage";
import { isPlainPlaidRecord, plaidRequest } from "@/lib/plaid/request";
import { syncPlaidBalanceSheet } from "@/lib/fund/syncPlaidBalanceSheet";
import { admitPlaidRequest } from "@/lib/plaid/admission";

const MAX_PLAID_CONNECTIONS_PER_USER = 1;
const MAX_PLAID_ACCOUNTS_PER_CONNECTION = 64;
const MAX_HOLDINGS_PER_SNAPSHOT = MAX_PORTFOLIO_QUOTE_SYMBOLS;
const MAX_LIABILITIES_PER_SNAPSHOT = 250;
const MAX_CONNECTIONS_PER_USER = 32;
const SNAPSHOT_VERSION = "financial-truth-v2";
type CashObservation = {
  input: FinancialInput;
  retrievedAt: string | null;
  persistentAccountIds: Array<string | null>;
};

function ensureJobActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Finance job aborted", "AbortError");
}

function cashObservation(
  input: FinancialInput,
  retrievedAt: string | null = null,
  persistentAccountIds: Array<string | null> = [],
): CashObservation {
  return { input, retrievedAt, persistentAccountIds };
}

/** Fetches live Plaid balances server-side for the finance-daily snapshot job. */
async function fetchPlaidCash(
  userId: string,
  accessToken: string,
  itemId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<CashObservation> {
  const creds = getPlaidCreds();
  if (!creds) return cashObservation(financialInput(null, { status: "missing", authority: "provider", currency: "USD", reason: "plaid_not_configured" }));
  try {
    ensureJobActive(signal);
    const admission = await admitPlaidRequest(userId, 12, 500, "axis:plaid-read:finance-cash");
    if (admission !== "allowed") {
      return cashObservation(financialInput(null, {
        status: "error",
        authority: "provider",
        currency: "USD",
        reason: "plaid_balance_admission_unavailable",
      }));
    }
    const data = await plaidRequest(creds, "/accounts/balance/get", accessToken, {}, {
      deadline,
      expectedItemId: itemId,
      maxResponseBytes: 128_000,
      signal,
    });
    const retrievedAt = new Date().toISOString();
    const accounts = data.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return cashObservation(financialInput(null, { status: "missing", authority: "provider", currency: "USD", reason: "plaid_balance_missing" }), retrievedAt);
    }
    if (accounts.length > MAX_PLAID_ACCOUNTS_PER_CONNECTION) {
      return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_account_limit_exceeded" }), retrievedAt);
    }
    let cashMinor = 0;
    const persistentAccountIds: Array<string | null> = [];
    let depositoryCount = 0;
    for (const account of accounts) {
      if (!isPlainPlaidRecord(account) || !isPlainPlaidRecord(account.balances)) {
        return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_invalid" }), retrievedAt);
      }
      // Non-depository accounts are partitioned into liabilities/positions and
      // never contaminate cash, but they do not make ordinary checking unusable.
      if (account.type !== "depository") continue;
      depositoryCount += 1;
      persistentAccountIds.push(
        typeof account.persistent_account_id === "string" && account.persistent_account_id
          ? account.persistent_account_id
          : null,
      );
      const currency = normalizeFinancialCurrency(account.balances.iso_currency_code, "");
      if (!currency) {
        return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_invalid_or_mixed_currency" }), retrievedAt);
      }
      const value = financialInput(account.balances.current, { authority: "provider", currency });
      if (value.status !== "fresh" || value.amountMinor === null || value.currency !== "USD") {
        return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_invalid_or_mixed_currency" }), retrievedAt);
      }
      const nextCash = addMinorUnits(cashMinor, value.amountMinor);
      if (nextCash === null) {
        return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_out_of_range" }), retrievedAt);
      }
      cashMinor = nextCash;
    }
    if (depositoryCount === 0) {
      return cashObservation(financialInput(null, { status: "missing", authority: "provider", currency: "USD", reason: "plaid_cash_account_missing" }), retrievedAt);
    }
    return cashObservation(
      financialInputMinor(cashMinor, { authority: "provider", currency: "USD" }),
      retrievedAt,
      persistentAccountIds,
    );
  } catch {
    return cashObservation(financialInput(null, { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_unavailable" }));
  }
}

async function fetchPlaidCashBounded(
  userId: string,
  credentials: ReadonlyArray<{ accessToken: string; itemId: string }>,
  deadlineMs = 10_000,
  signal?: AbortSignal,
): Promise<CashObservation[] | null> {
  const results: CashObservation[] = [];
  const deadline = Date.now() + deadlineMs;
  for (let start = 0; start < credentials.length; start += 4) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || signal?.aborted) return null;
    const batch = Promise.all(credentials.slice(start, start + 4).map((credential) =>
      fetchPlaidCash(userId, credential.accessToken, credential.itemId, deadline, signal),
    ));
    const completed = await Promise.race([
      batch,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ]);
    if (!completed) return null;
    results.push(...completed);
  }
  return results;
}

/**
 * Computes and upserts today's net_worth_snapshots row for one user —
 * cash from Plaid (live), invested from fund_holdings priced via Massive
 * where available, and liabilities from fund_liabilities. A missing price,
 * invalid amount, or mixed currency declines persistence rather than falling
 * back to cost basis or a fabricated zero. Deterministic; no AI involved.
 */
export async function snapshotNetWorth(
  admin: SupabaseClient,
  userId: string,
  signal?: AbortSignal,
): Promise<FinancialSnapshotOutcome> {
  ensureJobActive(signal);
  const preflightQuery = admin
    .from("fund_connections")
    .select("id, access_token_enc, item_id")
    .eq("user_id", userId)
    .eq("provider", "plaid")
    .eq("status", "linked")
    .eq("authority", "provider_verified")
    .limit(MAX_PLAID_CONNECTIONS_PER_USER + 1);
  const preflightResult = signal ? await preflightQuery.abortSignal(signal) : await preflightQuery;
  if (preflightResult.error) throw preflightResult.error;
  const preflightConnections = preflightResult.data ?? [];
  if (preflightConnections.length === 0) {
    return { status: "missing", authority: "provider", currency: "USD", reason: "no_linked_plaid_connection" };
  }
  if (preflightConnections.length > MAX_PLAID_CONNECTIONS_PER_USER) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_connection_limit_exceeded" };
  }
  const preflightConnection = preflightConnections[0];
  if (
    typeof preflightConnection.item_id !== "string"
    || !preflightConnection.item_id
    || typeof preflightConnection.access_token_enc !== "string"
    || !preflightConnection.access_token_enc
  ) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_item_identity_unavailable" };
  }
  let preflightAccessToken: string | null;
  try {
    preflightAccessToken = decrypt(preflightConnection.access_token_enc);
  } catch {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_token_unavailable" };
  }
  if (!preflightAccessToken) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_token_unavailable" };
  }
  const balanceSheet = await syncPlaidBalanceSheet(admin, userId, {
    id: preflightConnection.id,
    accessToken: preflightAccessToken,
    itemId: preflightConnection.item_id,
  }, signal);
  if (!balanceSheet.ok) {
    return {
      status: balanceSheet.reason === "plaid_balance_sheet_products_not_enabled" ? "missing" : "error",
      authority: "provider",
      currency: "USD",
      reason: balanceSheet.reason,
    };
  }
  if (balanceSheet.holdings.status !== "published") {
    return {
      status: balanceSheet.holdings.reason === "publish_failed" ? "error" : "missing",
      authority: "provider",
      currency: "USD",
      reason: `holding_provider_${balanceSheet.holdings.reason}`,
    };
  }
  if (balanceSheet.liabilities.status !== "published") {
    return {
      status: balanceSheet.liabilities.reason === "publish_failed" ? "error" : "missing",
      authority: "provider",
      currency: "USD",
      reason: `liability_provider_${balanceSheet.liabilities.reason}`,
    };
  }
  const provenance: Array<Record<string, string>> = [];
  const asOfTimes: string[] = [];
  const [connectionResult, holdingResult, liabilityResult, coverageResult] = await Promise.all([
    admin
      .from("fund_connections")
      .select("id, provider, status, authority, verified_at, access_token_enc, item_id")
      .eq("user_id", userId)
      .limit(MAX_CONNECTIONS_PER_USER + 1),
    admin
      .from("fund_holdings")
      .select("symbol, shares, source, authority, provider, provider_record_id, connection_id, retrieved_at, effective_at, currency, reconciliation_state, generation_id")
      .eq("user_id", userId)
      .limit(MAX_HOLDINGS_PER_SNAPSHOT + 1),
    admin
      .from("fund_liabilities")
      .select("balance, source, authority, provider, provider_record_id, connection_id, retrieved_at, effective_at, currency, reconciliation_state, generation_id")
      .eq("user_id", userId)
      .limit(MAX_LIABILITIES_PER_SNAPSHOT + 1),
    admin
      .from("fund_provider_coverage")
      .select("connection_id, provider, component, complete, record_count, retrieved_at, last_attempt_at, availability_status, availability_reason, generation_id, generation_hash")
      .eq("user_id", userId)
      .limit(MAX_CONNECTIONS_PER_USER * 2 + 1),
  ]);
  if (connectionResult.error) throw connectionResult.error;
  if (holdingResult.error) throw holdingResult.error;
  if (liabilityResult.error) throw liabilityResult.error;
  if (coverageResult.error) throw coverageResult.error;
  const connections = connectionResult.data ?? [];
  const holdings = holdingResult.data ?? [];
  const liabilityRows = liabilityResult.data ?? [];
  const coverageRows = coverageResult.data ?? [];
  if (connections.length > MAX_CONNECTIONS_PER_USER) {
    return { status: "error", authority: "provider", currency: "USD", reason: "connection_limit_exceeded" };
  }
  if (holdings.length > MAX_HOLDINGS_PER_SNAPSHOT) {
    return { status: "error", authority: "provider", currency: "USD", reason: "holding_limit_exceeded" };
  }
  if (liabilityRows.length > MAX_LIABILITIES_PER_SNAPSHOT) {
    return { status: "error", authority: "provider", currency: "USD", reason: "liability_limit_exceeded" };
  }
  if (coverageRows.length > MAX_CONNECTIONS_PER_USER * 2) {
    return { status: "error", authority: "provider", currency: "USD", reason: "provider_coverage_limit_exceeded" };
  }
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  const connectionMatches = (connectionId: unknown, provider: unknown) => {
    if (typeof connectionId !== "string" || typeof provider !== "string") return false;
    const connection = connectionById.get(connectionId);
    return connection?.provider === provider
      && connection.status === "linked"
      && connection.authority === "provider_verified"
      && typeof connection.verified_at === "string";
  };
  const activeConnections = connections.filter((connection) =>
    connection.status === "linked"
    && connection.authority === "provider_verified"
    && typeof connection.verified_at === "string",
  );
  if (holdings.some((holding) => holding.authority !== "provider" || (holding.source !== "plaid" && holding.source !== "public"))) {
    return { status: "missing", authority: "manual", currency: "USD", reason: "holding_not_provider_authoritative" };
  }
  if (liabilityRows.some((liability) => liability.authority !== "provider" || liability.source !== "plaid")) {
    return { status: "missing", authority: "manual", currency: "USD", reason: "liability_not_provider_authoritative" };
  }
  const coverageComplete = (
    component: "holdings" | "liabilities",
    relevantConnections: typeof activeConnections,
    rows: Array<{ connection_id: string | null }>,
  ) => relevantConnections.length > 0 && relevantConnections.every((connection) => {
    const fact = coverageRows.find((coverage) =>
      coverage.connection_id === connection.id
      && coverage.provider === connection.provider
      && coverage.component === component,
    );
    const sla = component === "holdings" ? FRESHNESS_SLAS.holdings : FRESHNESS_SLAS.accountBalance;
    return fact?.complete === true
      && fact.availability_status === "available"
      && classifyFreshness(fact.retrieved_at, sla) === "fresh"
      && fact.record_count === rows.filter((row) => row.connection_id === connection.id).length
      && typeof fact.generation_id === "string"
      && typeof fact.generation_hash === "string"
      && /^[0-9a-f]{64}$/.test(fact.generation_hash)
      && rows
        .filter((row) => row.connection_id === connection.id)
        .every((row) => "generation_id" in row && row.generation_id === fact.generation_id);
  });
  if (validateHoldingCoverage(holdings, activeConnections, coverageRows)) {
    return { status: "missing", authority: "provider", currency: "USD", reason: "holding_provider_coverage_missing" };
  }
  const plaidActiveConnections = activeConnections.filter((connection) => connection.provider === "plaid");
  if (!coverageComplete("liabilities", plaidActiveConnections, liabilityRows)) {
    return { status: "missing", authority: "provider", currency: "USD", reason: "liability_provider_coverage_missing" };
  }
  const activeConnectionIds = new Set(activeConnections.map((connection) => connection.id));
  for (const fact of coverageRows.filter((coverage) =>
    activeConnectionIds.has(coverage.connection_id)
    && (coverage.component === "holdings" || coverage.component === "liabilities"),
  )) {
    provenance.push({
      component: `${fact.component}_coverage`,
      provider: fact.provider,
      connection_id: fact.connection_id,
      retrieved_at: fact.retrieved_at,
      record_count: String(fact.record_count),
    });
    asOfTimes.push(fact.retrieved_at);
  }
  const holdingAuthorityFailure = validateAuthoritativeHoldings(holdings);
  if (holdingAuthorityFailure) {
    return {
      status: holdingAuthorityFailure === "HOLDING_PROVENANCE_UNAVAILABLE" ? "stale" : "error",
      authority: "stale",
      currency: "USD",
      reason: holdingAuthorityFailure.toLowerCase(),
    };
  }
  for (const holding of holdings) {
    if (!connectionMatches(holding.connection_id, holding.provider)) {
      return { status: "stale", authority: "stale", currency: "USD", reason: "holding_connection_not_authoritative" };
    }
    if (holding.currency !== "USD") {
      return { status: "error", authority: "provider", currency: "USD", reason: "holding_currency_requires_fx" };
    }
    const quantity = strictScaledUnits(holding.shares, MICRO_SHARES_PER_SHARE);
    if (quantity === null || quantity <= 0) {
      return { status: "error", authority: "provider", currency: "USD", reason: "holding_quantity_invalid" };
    }
  }
  let liabilitiesMinor = 0;
  for (const liability of liabilityRows) {
    const currency = normalizeFinancialCurrency(liability.currency, "");
    if (!currency) {
      return { status: "error", authority: "provider", currency: "USD", reason: "liability_currency_unavailable" };
    }
    if (currency.toUpperCase() !== "USD") {
      return { status: "error", authority: "provider", currency: "USD", reason: "liability_currency_requires_fx" };
    }
    if (!liability.provider || !liability.provider_record_id || !liability.connection_id || classifyFreshness(liability.retrieved_at, FRESHNESS_SLAS.accountBalance) !== "fresh") {
      return { status: "stale", authority: "stale", currency: "USD", reason: "liability_provenance_not_fresh" };
    }
    if (liability.reconciliation_state !== "matched") {
      return { status: "stale", authority: "stale", currency: "USD", reason: "liability_reconciliation_incomplete" };
    }
    if (!connectionMatches(liability.connection_id, liability.provider)) {
      return { status: "stale", authority: "stale", currency: "USD", reason: "liability_connection_not_authoritative" };
    }
    const amountMinor = strictMinorUnits(liability.balance, currency);
    if (amountMinor === null || amountMinor < 0) {
      return { status: "error", authority: "provider", currency: "USD", reason: "liability_balance_invalid" };
    }
    provenance.push({
      component: "liabilities",
      provider: liability.provider,
      provider_record_id: liability.provider_record_id,
      connection_id: liability.connection_id,
      retrieved_at: liability.retrieved_at,
    });
    asOfTimes.push(liability.retrieved_at);
    const nextLiabilities = addMinorUnits(liabilitiesMinor, amountMinor);
    if (nextLiabilities === null) {
      return { status: "error", authority: "provider", currency: "USD", reason: "liability_balance_out_of_range" };
    }
    liabilitiesMinor = nextLiabilities;
  }
  const liabilities = financialInputMinor(liabilitiesMinor, { authority: "provider", currency: "USD" });

  const plaidConnections = plaidActiveConnections;
  if (plaidConnections.length === 0) {
    return { status: "missing", authority: "provider", currency: "USD", reason: "no_linked_plaid_connection" };
  }
  if (plaidConnections.length > MAX_PLAID_CONNECTIONS_PER_USER) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_connection_limit_exceeded" };
  }
  if (plaidConnections.some((connection) =>
    typeof connection.item_id !== "string" || connection.item_id.length === 0
  )) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_item_identity_unavailable" };
  }
  let tokens: Array<{ connection: typeof plaidConnections[number]; token: string | null }>;
  try {
    tokens = plaidConnections.map((connection) => ({
      connection,
      token: connection.access_token_enc ? decrypt(connection.access_token_enc) : null,
    }));
  } catch {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_token_unavailable" };
  }
  if (tokens.some(({ token }) => !token)) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_token_unavailable" };
  }
  if (holdings.length > 0 && !getPolygonApiKey()) {
    return { status: "missing", authority: "provider", currency: "USD", reason: "market_price_not_configured" };
  }

  // All local authority/provenance checks complete before either provider is
  // contacted. Calls are capped, concurrent, and bounded by a shared deadline.
  const [cashResults, quoteResult] = await Promise.all([
    fetchPlaidCashBounded(userId, tokens.map(({ token, connection }) => ({
      accessToken: token as string,
      itemId: connection.item_id as string,
    })), 10_000, signal),
    holdings.length > 0
      ? fetchPortfolioQuotes(holdings.map((holding) => holding.symbol), fetchSnapshot, undefined, signal)
      : Promise.resolve({ quotes: new Map(), reason: null }),
  ]);
  if (!cashResults) {
    return { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_deadline_exceeded" };
  }
  const cashFailure = cashResults.find(({ input, retrievedAt }) =>
    input.status !== "fresh" || input.amountMinor === null || retrievedAt === null,
  );
  if (cashFailure) return {
    status: cashFailure.input.status === "fresh" ? "error" : cashFailure.input.status,
    authority: cashFailure.input.authority,
    currency: cashFailure.input.currency,
    reason: cashFailure.input.reason ?? "cash_input_unavailable",
  };
  let cashMinor = 0;
  for (let index = 0; index < cashResults.length; index++) {
    const amountMinor = cashResults[index].input.amountMinor as number;
    const retrievedAt = cashResults[index].retrievedAt as string;
    const nextCash = addMinorUnits(cashMinor, amountMinor);
    if (nextCash === null) {
      return { status: "error", authority: "provider", currency: "USD", reason: "plaid_balance_out_of_range" };
    }
    cashMinor = nextCash;
    provenance.push({
      component: "cash",
      provider: "plaid",
      connection_id: tokens[index].connection.id,
      retrieved_at: retrievedAt,
    });
    asOfTimes.push(retrievedAt);
  }
  const cash = financialInputMinor(cashMinor, { authority: "provider", currency: "USD" });
  if (quoteResult.reason) {
    return { status: "stale", authority: "stale", currency: "USD", reason: quoteResult.reason.toLowerCase() };
  }
  let investedMinor = 0;
  for (const holding of holdings) {
    const quote = quoteResult.quotes.get(holding.symbol);
    if (
      !quote ||
      quote.source !== "massive" ||
      typeof quote.asOf !== "string" ||
      classifyFreshness(quote.asOf, FRESHNESS_SLAS.marketPrice) !== "fresh"
    ) {
      return { status: "stale", authority: "stale", currency: "USD", reason: "market_quote_provenance_not_fresh" };
    }
    const quantityMicro = strictScaledUnits(holding.shares, MICRO_SHARES_PER_SHARE) as number;
    const marketValueMinor = multiplyScaledQuantityByDecimalPrice(
      quantityMicro,
      quote.price,
      MICRO_SHARES_PER_SHARE,
      "USD",
    );
    if (marketValueMinor === null || marketValueMinor <= 0) {
      return { status: "error", authority: "provider", currency: "USD", reason: "holding_quantity_or_quote_invalid" };
    }
    const nextInvested = marketValueMinor === null ? null : addMinorUnits(investedMinor, marketValueMinor);
    if (nextInvested === null) {
      return { status: "error", authority: "provider", currency: "USD", reason: "market_value_out_of_range" };
    }
    investedMinor = nextInvested;
    provenance.push({
      component: "invested",
      provider: holding.provider as string,
      provider_record_id: holding.provider_record_id as string,
      connection_id: holding.connection_id as string,
      retrieved_at: holding.retrieved_at as string,
      generation_id: holding.generation_id as string,
      quote_source: quote.source as string,
      quote_as_of: quote.asOf,
      symbol: holding.symbol,
    });
    asOfTimes.push(holding.retrieved_at as string, quote.asOf);
  }
  const invested = financialInputMinor(investedMinor, { authority: "provider", currency: "USD" });

  const outcome = completeProviderSnapshot({ cash, invested, liabilities });
  if (outcome.status !== "fresh" || outcome.authority !== "provider") return outcome;
  const exactValues = {
    cash: minorUnitsToDecimalString(outcome.cashMinor, outcome.currency),
    invested: minorUnitsToDecimalString(outcome.investedMinor, outcome.currency),
    liabilities: minorUnitsToDecimalString(outcome.liabilitiesMinor, outcome.currency),
    net_worth: minorUnitsToDecimalString(outcome.netWorthMinor, outcome.currency),
  };
  if (Object.values(exactValues).some((value) => value === null)) {
    return { status: "error", authority: "provider", currency: outcome.currency, reason: "snapshot_persistence_conversion_failed" };
  }
  const stableProvenance = provenance.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const inputAsOf = asOfTimes
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  if (!Number.isFinite(inputAsOf)) {
    return { status: "error", authority: "provider", currency: outcome.currency, reason: "snapshot_provenance_missing" };
  }
  const calculationHash = crypto.createHash("sha256").update(JSON.stringify({
    version: SNAPSHOT_VERSION,
    currency: outcome.currency,
    values: exactValues,
    input_as_of: new Date(inputAsOf).toISOString(),
    provenance: stableProvenance,
  })).digest("hex");
  const computedAt = new Date().toISOString();
  const { error: snapshotError } = await admin.from("net_worth_snapshots").upsert(
    {
      user_id: userId,
      captured_on: computedAt.slice(0, 10),
      ...exactValues,
      authority: "provider",
      snapshot_status: "fresh",
      currency: outcome.currency,
      calculation_version: SNAPSHOT_VERSION,
      calculation_hash: calculationHash,
      input_provenance: stableProvenance,
      input_as_of: new Date(inputAsOf).toISOString(),
      computed_at: computedAt,
    },
    { onConflict: "user_id,captured_on" },
  );
  if (snapshotError) throw snapshotError;
  return outcome;
}

type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";

function inferCadence(avgGapDays: number): Cadence {
  if (avgGapDays <= 10) return "weekly";
  if (avgGapDays <= 17) return "biweekly";
  if (avgGapDays <= 45) return "monthly";
  if (avgGapDays <= 120) return "quarterly";
  return "annual";
}

/**
 * Best-effort recurring-charge detection: groups spend transactions by
 * (merchant, rounded amount); two or more occurrences become a recurring
 * row with cadence inferred from the average gap between them. Manual
 * declarations (source='manual') are left untouched.
 */
export async function detectRecurring(
  admin: SupabaseClient,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  ensureJobActive(signal);
  const today = new Date().toISOString().slice(0, 10);
  const historyStart = new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  type RecurringTransactionRow = {
    merchant_name: string | null;
    amount: unknown;
    amount_minor: number | null;
    posted_date: string;
    iso_currency_code: string | null;
    connection_id: string | null;
    retrieved_at: string | null;
    generation_id: string | null;
    authority: string;
    is_transfer: boolean;
  };
  const complete = await readCompleteTransactionRows<RecurringTransactionRow>(
    admin,
    userId,
    historyStart,
    today,
    "merchant_name, amount, amount_minor, posted_date, iso_currency_code, connection_id, retrieved_at, generation_id, authority, is_transfer",
    signal,
  );
  if (!complete) return;
  const proof = complete.proof;
  const txns = complete.rows.filter((transaction) =>
    transaction.authority === "provider"
    && transaction.is_transfer === false
    && transaction.posted_date >= historyStart
    && (
      Number.isSafeInteger(transaction.amount_minor)
        ? (transaction.amount_minor as number) < 0
        : typeof transaction.amount === "number"
          ? transaction.amount < 0
          : typeof transaction.amount === "string" && transaction.amount.startsWith("-")
    ),
  );
  const lineage = coverageLineage(proof);
  if (!lineage || txns.length < 2) return;

  const groups = new Map<string, {
    merchant: string;
    amountMinor: number;
    currency: string;
    date: string;
  }[]>();
  for (const t of txns) {
    if (!t.merchant_name) continue;
    if (!t.connection_id || !t.retrieved_at || typeof t.iso_currency_code !== "string") {
      throw new Error("RECURRING_INPUT_PROVENANCE_OR_CURRENCY_UNAVAILABLE");
    }
    const amountMinor = Number.isSafeInteger(t.amount_minor)
      ? t.amount_minor
      : strictExactMinorUnits(t.amount, t.iso_currency_code);
    if (amountMinor === null || amountMinor >= 0) throw new Error("RECURRING_INPUT_AMOUNT_INVALID");
    const key = `${t.merchant_name}|${t.iso_currency_code}|${Math.abs(amountMinor)}`;
    const arr = groups.get(key) ?? [];
    arr.push({
      merchant: t.merchant_name,
      amountMinor,
      currency: t.iso_currency_code,
      date: t.posted_date,
    });
    groups.set(key, arr);
  }

  const { data: manualRows, error: manualError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, currency")
    .eq("user_id", userId)
    .eq("source", "manual");
  if (manualError) throw manualError;
  const manualKeys = new Set(
    (manualRows ?? []).map((row) => `${row.merchant_name}|${row.currency}`),
  );

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    if (manualKeys.has(`${group[0].merchant}|${group[0].currency}`)) continue;
    const dates = group.map((g) => new Date(g.date).getTime()).sort((a, b) => a - b);
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / 86400000);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const last = [...group].sort((left, right) => left.date.localeCompare(right.date)).at(-1);
    if (!last) continue;
    const expectedAmount = minorUnitsToDecimalString(Math.abs(last.amountMinor), last.currency);
    if (!expectedAmount) throw new Error("RECURRING_INPUT_AMOUNT_INVALID");

    const { error: recurringError } = await admin.from("fund_recurring_transactions").upsert(
      {
        user_id: userId,
        merchant_name: last.merchant,
        expected_amount: expectedAmount,
        currency: last.currency,
        cadence: inferCadence(avgGap),
        last_seen_date: last.date,
        next_expected_date: new Date(new Date(last.date).getTime() + avgGap * 86400000)
          .toISOString()
          .slice(0, 10),
        source: "detected",
        source_generations: lineage.source_generations,
        source_generation_hash: lineage.source_generation_hash,
        status: "active",
      },
      { onConflict: "user_id,merchant_name,currency,source", ignoreDuplicates: false },
    );
    if (recurringError) throw recurringError;
  }
}

/**
 * Writes a deterministic daily_brief row to ai_insights — plain computed
 * text from already-stored numbers, no AI call. Phase 5's tool-calling
 * Advisor will replace this with a richer, narrated brief that still only
 * reads from these same deterministic sources.
 */
export async function writeDailyBrief(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  snapshot: FinancialSnapshotOutcome,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  // A persisted historical row alone does not prove today's input set was
  // complete. Never emit a high-confidence brief from partial/stale data.
  if (snapshot.status !== "fresh" || snapshot.authority !== "provider") return noNotifications();
  const { data: snapshots, error: snapshotError } = await admin
    .from("net_worth_snapshots_exact")
    .select("captured_on, net_worth, currency")
    .eq("user_id", userId)
    .eq("authority", "provider")
    .eq("snapshot_status", "fresh")
    .eq("calculation_version", SNAPSHOT_VERSION)
    .order("captured_on", { ascending: false })
    .limit(8);
  if (snapshotError) throw snapshotError;

  if (!snapshots || snapshots.length < 1) return noNotifications();
  const today = snapshots[0];
  const weekAgo = snapshots.find((s) => s.captured_on !== today.captured_on);
  const todayMinor = strictMinorUnits(today.net_worth, today.currency ?? "");
  const weekAgoMinor = weekAgo ? strictMinorUnits(weekAgo.net_worth, weekAgo.currency ?? "") : null;
  if (todayMinor === null || (weekAgo && weekAgoMinor === null)) {
    throw new Error("NET_WORTH_HISTORY_INVALID");
  }
  const changeMinor = weekAgoMinor === null ? 0 : addMinorUnits(todayMinor, -weekAgoMinor);
  if (changeMinor === null) throw new Error("NET_WORTH_HISTORY_OUT_OF_RANGE");
  const changePctTenths = weekAgoMinor !== null && weekAgoMinor > 0
    ? (() => {
        const denominator = BigInt(weekAgoMinor);
        const numerator = BigInt(changeMinor) * BigInt(1000);
        const adjustment = denominator / BigInt(2);
        return (numerator + (numerator >= 0 ? adjustment : -adjustment)) / denominator;
      })()
    : null;
  const absoluteChangePctTenths =
    changePctTenths !== null && changePctTenths < BigInt(0) ? -changePctTenths : changePctTenths;
  const changePercentExact =
    absoluteChangePctTenths === null
      ? null
      : `${absoluteChangePctTenths / BigInt(10)}.${absoluteChangePctTenths % BigInt(10)}`;
  const todayExact = minorUnitsToDecimalString(todayMinor, "USD");
  const absoluteChangeExact = minorUnitsToDecimalString(Math.abs(changeMinor), "USD");
  if (!todayExact || !absoluteChangeExact) throw new Error("NET_WORTH_HISTORY_INVALID");

  const body = !weekAgo
    ? `First snapshot recorded: net worth $${todayExact}.`
    : changePercentExact !== null
      ? `Net worth is ${changeMinor >= 0 ? "up" : "down"} ${changePercentExact}% since ${weekAgo.captured_on}, now $${todayExact}.`
      : `Net worth ${changeMinor > 0 ? "increased" : changeMinor < 0 ? "decreased" : "changed"} by $${absoluteChangeExact} since ${weekAgo.captured_on}, now $${todayExact}. Percentage change is unavailable because the prior net worth was not positive.`;

  const { error: insightError } = await admin.from("ai_insights").insert({
    user_id: userId,
    kind: "daily_brief",
    title: "Daily brief",
    body,
    data_used: { snapshots },
    assumptions: "Computed directly from net_worth_snapshots — no AI interpretation applied.",
    confidence: "high",
    requires_review: false,
  });
  if (insightError) throw insightError;

  if (userEmail) {
    const result = await notifyViaMake(admin, {
      idempotencyKey: `daily_brief:${userId}:${today.captured_on}`,
      kind: "daily_brief",
      userId,
      to: userEmail,
      subject: "Your daily finance brief",
      bodyText: body,
      meta: { net_worth: todayExact, change: minorUnitsToDecimalString(changeMinor, "USD") },
    });
    return notificationOutcome([result]);
  }
  return noNotifications();
}

/**
 * FIN-503/506: bill-reminder check. Fires 2 days before a recurring
 * charge's next_expected_date — deterministic, no AI needed for "this bill
 * is due soon." Supplies a stable merchant/date key for Make-side deduplication.
 */
export async function sendBillReminders(
  admin: SupabaseClient,
  userId: string,
  userEmail: string | null,
  signal?: AbortSignal,
): Promise<FinanceNotificationOutcome> {
  ensureJobActive(signal);
  if (!userEmail) return noNotifications();
  const reminderDate = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  const { data: dueSoon, error: recurringError } = await admin
    .from("fund_recurring_transactions")
    .select("merchant_name, expected_amount, currency, next_expected_date, source, source_generation_hash")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("next_expected_date", reminderDate);
  if (recurringError) throw recurringError;

  const candidates = dueSoon ?? [];
  const detected = candidates.filter((bill) => bill.source === "detected");
  let proof = null;
  if (detected.length > 0) {
    const historyStart = new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    proof = await readCompleteTransactionCoverage(
      admin,
      userId,
      historyStart,
      new Date().toISOString().slice(0, 10),
    );
  }
  const results = [];
  for (const bill of candidates) {
    if (bill.source === "detected" && (!proof || !detectedRecurringMatchesCoverage(bill, proof))) {
      continue;
    }
    const currency = typeof bill.currency === "string" ? bill.currency : "";
    const amountMinor = strictExactMinorUnits(bill.expected_amount, currency);
    const amount = amountMinor === null ? null : minorUnitsToDecimalString(amountMinor, currency);
    if (amountMinor === null || amount === null || amountMinor < 0) {
      throw new Error("BILL_REMINDER_AMOUNT_INVALID");
    }
    results.push(await notifyViaMake(admin, {
      idempotencyKey: `bill_reminder:${userId}:${bill.merchant_name}:${bill.next_expected_date}`,
      kind: "bill_reminder",
      userId,
      to: userEmail,
      subject: `Upcoming bill: ${bill.merchant_name}`,
      bodyText: `${bill.merchant_name} (${amount} ${currency}) is expected on ${bill.next_expected_date}.`,
      meta: { merchant: bill.merchant_name, amount, amount_minor: amountMinor, currency, due_date: bill.next_expected_date },
    }));
  }
  return notificationOutcome(results);
}
