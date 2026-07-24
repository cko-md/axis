import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlaidCreds } from "@/app/api/plaid/_lib";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  scaledUnitsToDecimalString,
  strictExactMinorUnits,
  strictScaledUnits,
} from "@/lib/fund/financialTruth";
import { MICRO_SHARES_PER_SHARE } from "@/lib/fund/taxLots";
import { isPlainPlaidRecord, plaidRequest } from "@/lib/plaid/request";
import { admitPlaidRequest } from "@/lib/plaid/admission";

const MAX_HOLDINGS = 512;
const MAX_LIABILITIES = 256;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;

type Connection = {
  id: string;
  accessToken: string;
  itemId: string;
};

type ComponentUnavailableReason =
  | "product_not_billed"
  | "provider_unavailable"
  | "payload_incomplete"
  | "publish_failed";

type ComponentPublication =
  | { status: "published"; recordCount: number }
  | { status: "unavailable"; reason: ComponentUnavailableReason };

export type BalanceSheetPublication =
  | { ok: true; holdings: ComponentPublication; liabilities: ComponentPublication }
  | {
      ok: false;
      reason:
        | "plaid_not_configured"
        | "plaid_balance_sheet_products_not_enabled"
        | "plaid_balance_sheet_provider_unavailable"
        | "plaid_balance_sheet_payload_invalid"
        | "plaid_balance_sheet_publish_failed";
    };

type PublicationRpc = (
  name: string,
  params: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

function stringField(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : null;
}

function billedProducts(item: Record<string, unknown>): Set<string> | null {
  const products = new Set<string>();
  const value = item.billed_products;
  if (!Array.isArray(value) || value.length > 64) return null;
  for (const product of value) {
    if (typeof product !== "string" || product.length < 1 || product.length > 64) return null;
    products.add(product);
  }
  return products;
}

function normalizeHoldingRows(data: Record<string, unknown>) {
  if (
    !Array.isArray(data.holdings)
    || data.holdings.length > MAX_HOLDINGS
    || !Array.isArray(data.securities)
    || data.securities.length > MAX_HOLDINGS
  ) return null;
  const securities = new Map<string, { symbol: string; name: string }>();
  for (const candidate of data.securities) {
    if (!isPlainPlaidRecord(candidate)) return null;
    const securityId = stringField(candidate.security_id, 256);
    const symbol = stringField(candidate.ticker_symbol, 15)?.toUpperCase() ?? null;
    const name = stringField(candidate.name, 256);
    if (!securityId || !symbol || !SYMBOL.test(symbol) || !name || securities.has(securityId)) return null;
    securities.set(securityId, { symbol, name });
  }
  const rows: Array<Record<string, string>> = [];
  const identities = new Set<string>();
  for (const candidate of data.holdings) {
    if (!isPlainPlaidRecord(candidate)) return null;
    const securityId = stringField(candidate.security_id, 256);
    const accountId = stringField(candidate.account_id, 256);
    const security = securityId ? securities.get(securityId) : null;
    const currency = normalizeFinancialCurrency(candidate.iso_currency_code, "");
    const sharesMicro = strictScaledUnits(candidate.quantity, MICRO_SHARES_PER_SHARE);
    const basisMinor = currency ? strictExactMinorUnits(candidate.cost_basis, currency) : null;
    const providerRecordId = accountId && securityId ? `${accountId}:${securityId}` : null;
    if (
      !security
      || !currency
      || !providerRecordId
      || providerRecordId.length > 512
      || identities.has(providerRecordId)
      || sharesMicro === null
      || sharesMicro <= 0
      || basisMinor === null
      || basisMinor < 0
    ) return null;
    const shares = scaledUnitsToDecimalString(sharesMicro, MICRO_SHARES_PER_SHARE);
    const costBasis = minorUnitsToDecimalString(basisMinor, currency);
    if (!shares || !costBasis) return null;
    identities.add(providerRecordId);
    rows.push({
      provider_record_id: providerRecordId,
      symbol: security.symbol,
      name: security.name,
      shares,
      cost_basis: costBasis,
      currency,
    });
  }
  return rows;
}

function normalizeLiabilityRows(data: Record<string, unknown>) {
  if (
    !Array.isArray(data.accounts)
    || data.accounts.length > 64
    || !isPlainPlaidRecord(data.liabilities)
  ) return null;
  const accounts = new Map<string, { name: string; balance: string; currency: string }>();
  for (const candidate of data.accounts) {
    if (!isPlainPlaidRecord(candidate) || !isPlainPlaidRecord(candidate.balances)) return null;
    const accountId = stringField(candidate.account_id, 256);
    const name = stringField(candidate.name, 256);
    const currency = normalizeFinancialCurrency(candidate.balances.iso_currency_code, "");
    const balanceMinor = currency
      ? strictExactMinorUnits(candidate.balances.current, currency)
      : null;
    const balance = currency && balanceMinor !== null
      ? minorUnitsToDecimalString(balanceMinor, currency)
      : null;
    if (!accountId || !name || !currency || balanceMinor === null || balanceMinor < 0 || !balance) return null;
    accounts.set(accountId, { name, balance, currency });
  }
  const rows: Array<Record<string, string | null>> = [];
  const identities = new Set<string>();
  for (const [plaidType, kind] of [
    ["credit", "credit_card"],
    ["student", "student_loan"],
    ["mortgage", "mortgage"],
  ] as const) {
    const candidates = data.liabilities[plaidType];
    if (candidates === null || candidates === undefined) continue;
    if (!Array.isArray(candidates) || candidates.length > MAX_LIABILITIES) return null;
    for (const candidate of candidates) {
      if (!isPlainPlaidRecord(candidate)) return null;
      const accountId = stringField(candidate.account_id, 256);
      const account = accountId ? accounts.get(accountId) : null;
      if (!accountId || !account || identities.has(accountId)) return null;
      const minimumProvided = candidate.minimum_payment_amount !== null
        && candidate.minimum_payment_amount !== undefined;
      const minimumMinor = !minimumProvided
        ? null
        : strictExactMinorUnits(candidate.minimum_payment_amount, account.currency);
      const minimumPayment = minimumMinor === null
        ? null
        : minorUnitsToDecimalString(minimumMinor, account.currency);
      const dueDate = candidate.next_payment_due_date === null
        || candidate.next_payment_due_date === undefined
        ? null
        : typeof candidate.next_payment_due_date === "string"
          && /^\d{4}-\d{2}-\d{2}$/.test(candidate.next_payment_due_date)
          ? candidate.next_payment_due_date
          : undefined;
      if (
        minimumProvided && minimumMinor === null
        || minimumMinor !== null && minimumMinor < 0
        || minimumMinor !== null && !minimumPayment
        || dueDate === undefined
      ) return null;
      identities.add(accountId);
      rows.push({
        provider_record_id: accountId,
        kind,
        name: account.name,
        balance: account.balance,
        minimum_payment: minimumPayment,
        due_date: dueDate,
        currency: account.currency,
      });
    }
  }
  return rows.length <= MAX_LIABILITIES ? rows : null;
}

async function publish(
  admin: SupabaseClient,
  functionName: "publish_fund_holding_generation" | "publish_fund_liability_generation",
  userId: string,
  connectionId: string,
  retrievedAt: string,
  rows: Array<Record<string, string | null>>,
): Promise<boolean> {
  const rpc = (admin as unknown as { rpc?: PublicationRpc }).rpc;
  if (typeof rpc !== "function") return false;
  const generationId = crypto.randomUUID();
  try {
    const { data, error } = await rpc.call(admin, functionName, {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_retrieved_at: retrievedAt,
      p_generation_id: generationId,
      p_rows: rows,
    });
    const row = Array.isArray(data) && data.length === 1 && isPlainPlaidRecord(data[0])
      ? data[0]
      : null;
    return !error
      && row?.record_count === rows.length
      && typeof row.generation_hash === "string"
      && /^[0-9a-f]{64}$/.test(row.generation_hash);
  } catch {
    return false;
  }
}

async function markUnavailable(
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
  component: "holdings" | "liabilities",
  recordCount: number | null,
  retrievedAt: string,
  reason: ComponentUnavailableReason,
): Promise<boolean> {
  const rpc = (admin as unknown as { rpc?: PublicationRpc }).rpc;
  if (typeof rpc !== "function") return false;
  try {
    const { data, error } = await rpc.call(admin, "mark_fund_provider_component_unavailable", {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_component: component,
      p_record_count: recordCount,
      p_attempted_at: retrievedAt,
      p_availability_status: reason === "provider_unavailable" || reason === "publish_failed" ? "error" : "unavailable",
      p_availability_reason: reason,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

/**
 * Refreshes the two provider-authoritative balance-sheet components and
 * publishes each as one atomic generation. It never requests or adds a Plaid
 * product. Publication proceeds only when Item metadata proves the product was
 * already billed; consent alone is not authority for an autonomous billable read.
 */
export async function syncPlaidBalanceSheet(
  admin: SupabaseClient,
  userId: string,
  connection: Connection,
  signal?: AbortSignal,
): Promise<BalanceSheetPublication> {
  const credentials = getPlaidCreds();
  if (!credentials) return { ok: false, reason: "plaid_not_configured" };
  const deadline = Date.now() + 18_000;
  const retrievedAt = new Date().toISOString();
  const markBoth = async (
    reason: ComponentUnavailableReason,
  ): Promise<{ ok: true; holdings: ComponentPublication; liabilities: ComponentPublication }> => {
    const [holdingMarked, liabilityMarked] = await Promise.all([
      markUnavailable(admin, userId, connection.id, "holdings", null, retrievedAt, reason),
      markUnavailable(admin, userId, connection.id, "liabilities", null, retrievedAt, reason),
    ]);
    return {
      ok: true,
      holdings: {
        status: "unavailable",
        reason: holdingMarked ? reason : "publish_failed",
      },
      liabilities: {
        status: "unavailable",
        reason: liabilityMarked ? reason : "publish_failed",
      },
    };
  };
  const itemAdmission = await admitPlaidRequest(userId, 12, 500, "axis:plaid-read:balance-sheet-item");
  if (itemAdmission !== "allowed") {
    return markBoth("provider_unavailable");
  }
  let itemData: Record<string, unknown>;
  try {
    itemData = await plaidRequest(credentials, "/item/get", connection.accessToken, {}, {
      deadline,
      expectedItemId: connection.itemId,
      maxResponseBytes: 64_000,
      signal,
    });
  } catch {
    return markBoth("provider_unavailable");
  }
  if (!isPlainPlaidRecord(itemData.item)) {
    return markBoth("payload_incomplete");
  }
  const products = billedProducts(itemData.item);
  if (!products) return markBoth("payload_incomplete");

  const refreshHoldings = async (): Promise<ComponentPublication> => {
    if (!products.has("investments")) {
      const marked = await markUnavailable(admin, userId, connection.id, "holdings", null, retrievedAt, "product_not_billed");
      return marked
        ? { status: "unavailable", reason: "product_not_billed" }
        : { status: "unavailable", reason: "publish_failed" };
    }
    const admission = await admitPlaidRequest(userId, 12, 500, "axis:plaid-read:holdings");
    if (admission !== "allowed") {
      await markUnavailable(admin, userId, connection.id, "holdings", null, retrievedAt, "provider_unavailable");
      return { status: "unavailable", reason: "provider_unavailable" };
    }
    let data: Record<string, unknown>;
    try {
      data = await plaidRequest(credentials, "/investments/holdings/get", connection.accessToken, {}, {
        deadline,
        expectedItemId: connection.itemId,
        maxResponseBytes: 1_000_000,
        signal,
      });
    } catch {
      await markUnavailable(admin, userId, connection.id, "holdings", null, retrievedAt, "provider_unavailable");
      return { status: "unavailable", reason: "provider_unavailable" };
    }
    const rows = normalizeHoldingRows(data);
    if (!rows) {
      const count = Array.isArray(data.holdings) && data.holdings.length <= MAX_HOLDINGS
        ? data.holdings.length
        : 0;
      await markUnavailable(admin, userId, connection.id, "holdings", count, retrievedAt, "payload_incomplete");
      return { status: "unavailable", reason: "payload_incomplete" };
    }
    const published = await publish(
      admin,
      "publish_fund_holding_generation",
      userId,
      connection.id,
      retrievedAt,
      rows,
    );
    if (!published) {
      await markUnavailable(admin, userId, connection.id, "holdings", rows.length, retrievedAt, "publish_failed");
      return { status: "unavailable", reason: "publish_failed" };
    }
    return { status: "published", recordCount: rows.length };
  };
  const refreshLiabilities = async (): Promise<ComponentPublication> => {
    if (!products.has("liabilities")) {
      const marked = await markUnavailable(admin, userId, connection.id, "liabilities", null, retrievedAt, "product_not_billed");
      return marked
        ? { status: "unavailable", reason: "product_not_billed" }
        : { status: "unavailable", reason: "publish_failed" };
    }
    const admission = await admitPlaidRequest(userId, 12, 500, "axis:plaid-read:liabilities");
    if (admission !== "allowed") {
      await markUnavailable(admin, userId, connection.id, "liabilities", null, retrievedAt, "provider_unavailable");
      return { status: "unavailable", reason: "provider_unavailable" };
    }
    let data: Record<string, unknown>;
    try {
      data = await plaidRequest(credentials, "/liabilities/get", connection.accessToken, {}, {
        deadline,
        expectedItemId: connection.itemId,
        maxResponseBytes: 1_000_000,
        signal,
      });
    } catch {
      await markUnavailable(admin, userId, connection.id, "liabilities", null, retrievedAt, "provider_unavailable");
      return { status: "unavailable", reason: "provider_unavailable" };
    }
    const rows = normalizeLiabilityRows(data);
    if (!rows) {
      const liabilityPayload = isPlainPlaidRecord(data.liabilities) ? data.liabilities : null;
      const liabilities = liabilityPayload
        ? ["credit", "student", "mortgage"].reduce((count, key) =>
          count + (Array.isArray(liabilityPayload[key]) ? liabilityPayload[key].length : 0), 0)
        : 0;
      await markUnavailable(admin, userId, connection.id, "liabilities", liabilities, retrievedAt, "payload_incomplete");
      return { status: "unavailable", reason: "payload_incomplete" };
    }
    const published = await publish(
      admin,
      "publish_fund_liability_generation",
      userId,
      connection.id,
      retrievedAt,
      rows,
    );
    if (!published) {
      await markUnavailable(admin, userId, connection.id, "liabilities", rows.length, retrievedAt, "publish_failed");
      return { status: "unavailable", reason: "publish_failed" };
    }
    return { status: "published", recordCount: rows.length };
  };
  const [holdings, liabilities] = await Promise.all([refreshHoldings(), refreshLiabilities()]);
  return { ok: true, holdings, liabilities };
}
