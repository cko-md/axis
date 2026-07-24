import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlaidCreds, plaidHost } from "@/app/api/plaid/_lib";
import { categorizeProviderActivity } from "@/lib/fund/activityRules";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";
import { TRANSACTION_HISTORY_DAYS } from "@/lib/fund/transactionCoverage";
import { timedProviderFetch } from "@/lib/observability/providerTiming";

const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const MAX_RECORDS = PAGE_SIZE * MAX_PAGES;
const SYNC_DEADLINE_MS = 25_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type PlaidTxn = {
  transaction_id?: unknown;
  account_id?: unknown;
  name?: unknown;
  merchant_name?: unknown;
  amount?: unknown;
  date?: unknown;
  authorized_date?: unknown;
  personal_finance_category?: { primary?: unknown } | null;
  pending?: unknown;
  iso_currency_code?: unknown;
};

type PublishedTransaction = {
  plaid_transaction_id: string;
  account_id: string;
  merchant_name: string;
  raw_name: string;
  amount: string;
  amount_minor: number;
  plaid_category: string;
  posted_date: string;
  authorized_date: string | null;
  pending: boolean;
  retrieved_at: string;
  iso_currency_code: string;
  provider: "plaid";
  authority: "provider";
  generation_id: string;
};

function syncError(code: string): { error: string } {
  return { error: code };
}

function normalizeTransaction(
  transaction: PlaidTxn,
  generationId: string,
  retrievedAt: string,
  windowStart: string,
  windowEnd: string,
): PublishedTransaction | { error: string } {
  const currency = normalizeFinancialCurrency(transaction.iso_currency_code, "");
  if (!currency) return syncError("PLAID_TRANSACTION_CURRENCY_UNAVAILABLE");
  const providerMinor = strictExactMinorUnits(transaction.amount, currency);
  if (providerMinor === null) return syncError("PLAID_TRANSACTION_AMOUNT_INVALID");
  const amountMinor = -providerMinor;
  const amount = minorUnitsToDecimalString(amountMinor, currency);
  if (!amount) return syncError("PLAID_TRANSACTION_AMOUNT_INVALID");

  const transactionId = typeof transaction.transaction_id === "string"
    ? transaction.transaction_id.trim()
    : "";
  const accountId = typeof transaction.account_id === "string"
    ? transaction.account_id.trim()
    : "";
  const name = typeof transaction.name === "string" ? transaction.name.trim() : "";
  const merchantName = typeof transaction.merchant_name === "string"
    ? transaction.merchant_name.trim()
    : name;
  const postedDate = typeof transaction.date === "string" ? transaction.date : "";
  const authorizedDate = transaction.authorized_date == null
    ? null
    : typeof transaction.authorized_date === "string"
      ? transaction.authorized_date
      : "";
  if (
    !transactionId
    || !accountId
    || !name
    || !merchantName
    || !DATE_ONLY.test(postedDate)
    || postedDate < windowStart
    || postedDate > windowEnd
    || (authorizedDate !== null && !DATE_ONLY.test(authorizedDate))
    || (transaction.pending !== undefined && typeof transaction.pending !== "boolean")
  ) return syncError("PLAID_INVALID_RESPONSE");

  const providerCategory = transaction.personal_finance_category?.primary;
  return {
    plaid_transaction_id: transactionId,
    account_id: accountId,
    merchant_name: merchantName,
    raw_name: name,
    amount,
    amount_minor: amountMinor,
    plaid_category: categorizeProviderActivity(
      typeof providerCategory === "string" ? providerCategory : undefined,
    ),
    posted_date: postedDate,
    authorized_date: authorizedDate,
    pending: transaction.pending === true,
    retrieved_at: retrievedAt,
    iso_currency_code: currency,
    provider: "plaid",
    authority: "provider",
    generation_id: generationId,
  };
}

function generationHash(rows: readonly PublishedTransaction[]): string {
  const canonical = [...rows]
    .sort((left, right) => left.plaid_transaction_id.localeCompare(right.plaid_transaction_id))
    .map((row) => ({
      plaid_transaction_id: row.plaid_transaction_id,
      account_id: row.account_id,
      amount: row.amount,
      amount_minor: row.amount_minor,
      iso_currency_code: row.iso_currency_code,
      posted_date: row.posted_date,
      authorized_date: row.authorized_date,
      pending: row.pending,
      merchant_name: row.merchant_name,
      raw_name: row.raw_name,
      plaid_category: row.plaid_category,
    }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Pull a bounded 90-day Plaid transaction generation. No database state is
 * published until every provider page has arrived and every fact validates.
 * Real Supabase clients publish rows, reconciliation, transfer tags, the fact
 * hash, and coverage in one database transaction through the RPC.
 */
export async function syncPlaidTransactions(
  admin: SupabaseClient,
  userId: string,
  connectionId: string,
  accessToken: string,
  cancellationSignal?: AbortSignal,
): Promise<{ synced: number } | { error: string }> {
  const creds = getPlaidCreds();
  if (!creds) return syncError("PLAID_NOT_CONFIGURED");

  const startedAt = Date.now();
  const deadline = startedAt + SYNC_DEADLINE_MS;
  const end = new Date(startedAt);
  const start = new Date(startedAt - TRANSACTION_HISTORY_DAYS * 86_400_000);
  const windowStart = start.toISOString().slice(0, 10);
  const windowEnd = end.toISOString().slice(0, 10);
  const generationId = crypto.randomUUID();
  const rawTransactions: PlaidTxn[] = [];
  const seen = new Set<string>();
  let expectedTotal: number | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (cancellationSignal?.aborted || Date.now() >= deadline) {
      return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
    }
    const offset = page * PAGE_SIZE;
    const remainingMs = Math.max(1, Math.min(10_000, deadline - Date.now()));
    const requestSignal = cancellationSignal
      ? AbortSignal.any([cancellationSignal, AbortSignal.timeout(remainingMs)])
      : AbortSignal.timeout(remainingMs);
    const response = await timedProviderFetch(
      `${plaidHost(creds.env)}/transactions/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestSignal,
        body: JSON.stringify({
          client_id: creds.clientId,
          secret: creds.secret,
          access_token: accessToken,
          start_date: windowStart,
          end_date: windowEnd,
          options: { count: PAGE_SIZE, offset },
        }),
      },
      {
        area: "fund",
        provider: "plaid",
        operation: "sync_transactions",
        timeoutMs: 10_000,
        slowMs: 2_500,
      },
    ).catch(() => null);
    if (!response?.ok) return syncError("PLAID_TXN_FETCH_FAILED");

    let body: { transactions?: unknown; total_transactions?: unknown };
    try {
      body = await response.json() as typeof body;
    } catch {
      return syncError("PLAID_INVALID_RESPONSE");
    }
    if (
      !Array.isArray(body.transactions)
      || !Number.isSafeInteger(body.total_transactions)
      || (body.total_transactions as number) < 0
      || (body.total_transactions as number) > MAX_RECORDS
      || body.transactions.length > PAGE_SIZE
    ) return syncError("PLAID_INVALID_RESPONSE");
    const total = body.total_transactions as number;
    if (expectedTotal === null) expectedTotal = total;
    if (expectedTotal !== total) return syncError("PLAID_TXN_GENERATION_CHANGED");

    for (const candidate of body.transactions) {
      if (!candidate || typeof candidate !== "object") return syncError("PLAID_INVALID_RESPONSE");
      const transactionId = (candidate as PlaidTxn).transaction_id;
      if (typeof transactionId !== "string" || !transactionId.trim() || seen.has(transactionId)) {
        return syncError("PLAID_INVALID_RESPONSE");
      }
      seen.add(transactionId);
      rawTransactions.push(candidate as PlaidTxn);
      if (rawTransactions.length > MAX_RECORDS) return syncError("PLAID_TXN_RECORD_LIMIT_EXCEEDED");
    }

    if (offset + PAGE_SIZE >= total) break;
    if (body.transactions.length === 0 || page === MAX_PAGES - 1) {
      return syncError("PLAID_TXN_INCOMPLETE");
    }
  }

  if (expectedTotal === null || rawTransactions.length !== expectedTotal) {
    return syncError("PLAID_TXN_INCOMPLETE");
  }
  if (Date.now() >= deadline) return syncError("PLAID_TXN_DEADLINE_EXCEEDED");

  // Retrieval time is stamped only after the final provider body has been
  // received and parsed. A partial/failed page never advances provenance.
  const retrievedAt = new Date().toISOString();
  const rows: PublishedTransaction[] = [];
  for (const transaction of rawTransactions) {
    const normalized = normalizeTransaction(
      transaction,
      generationId,
      retrievedAt,
      windowStart,
      windowEnd,
    );
    if ("error" in normalized) return normalized;
    rows.push(normalized);
  }
  const hash = generationHash(rows);

  const rpc = (admin as unknown as {
    rpc?: (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>;
  }).rpc;
  if (typeof rpc === "function") {
    const { error } = await rpc.call(admin, "publish_fund_transaction_generation", {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_window_start: windowStart,
      p_window_end: windowEnd,
      p_retrieved_at: retrievedAt,
      p_generation_id: generationId,
      p_rows: rows,
    });
    return error ? syncError("PLAID_TRANSACTION_PERSIST_FAILED") : { synced: rows.length };
  }

  // Deterministic lightweight test clients do not implement RPC. Production
  // Supabase clients always take the atomic path above; a missing RPC outside
  // Vitest is a hard failure and can never degrade into non-atomic writes.
  if (process.env.NODE_ENV !== "test") {
    return syncError("PLAID_TRANSACTION_ATOMIC_PUBLISH_UNAVAILABLE");
  }
  if (rows.length > 0) {
    const { error } = await admin
      .from("fund_bank_transactions")
      .upsert(rows.map((row) => ({ ...row, user_id: userId, connection_id: connectionId })), {
        onConflict: "user_id,provider,connection_id,plaid_transaction_id",
      });
    if (error) return syncError("PLAID_TRANSACTION_PERSIST_FAILED");
  }
  const transferError = await tagTransfers(admin, userId);
  if (transferError) return syncError(transferError);
  const { error: coverageError } = await admin.from("fund_provider_coverage").upsert({
    user_id: userId,
    connection_id: connectionId,
    provider: "plaid",
    component: "transactions",
    complete: true,
    record_count: rows.length,
    retrieved_at: retrievedAt,
    window_start: windowStart,
    window_end: windowEnd,
    generation_id: generationId,
    generation_hash: hash,
  }, { onConflict: "connection_id,component" });
  return coverageError
    ? syncError("PLAID_TRANSACTION_COVERAGE_PERSIST_FAILED")
    : { synced: rows.length };
}

/**
 * Test-client fallback for deterministic transfer tagging. The production RPC
 * performs the equivalent operation inside the publication transaction.
 */
async function tagTransfers(admin: SupabaseClient, userId: string): Promise<string | null> {
  const since = new Date(Date.now() - (TRANSACTION_HISTORY_DAYS + 2) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: transactions, error } = await admin
    .from("fund_bank_transactions")
    .select("id, connection_id, account_id, amount, amount_minor, iso_currency_code, posted_date, is_transfer")
    .eq("user_id", userId)
    .gte("posted_date", since);
  if (error) return "PLAID_TRANSFER_SCAN_FAILED";
  if (!transactions || transactions.length < 2) return null;

  const ordered = [...transactions].sort((left, right) =>
    left.posted_date === right.posted_date
      ? String(left.id).localeCompare(String(right.id))
      : String(left.posted_date).localeCompare(String(right.posted_date)),
  );
  const toTag = new Set<string>();
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex++) {
    const left = ordered[leftIndex];
    if (left.is_transfer || toTag.has(left.id)) continue;
    const currency = normalizeFinancialCurrency(left.iso_currency_code, "");
    const leftMinor = Number.isSafeInteger(left.amount_minor)
      ? left.amount_minor
      : currency
        ? strictExactMinorUnits(left.amount, currency)
        : null;
    if (!currency || leftMinor === null || leftMinor === 0) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex++) {
      const right = ordered[rightIndex];
      if (
        right.is_transfer
        || toTag.has(right.id)
        || (
          left.connection_id === right.connection_id
          && left.account_id === right.account_id
        )
      ) continue;
      if (normalizeFinancialCurrency(right.iso_currency_code, "") !== currency) continue;
      const rightMinor = Number.isSafeInteger(right.amount_minor)
        ? right.amount_minor
        : strictExactMinorUnits(right.amount, currency);
      if (rightMinor === null || rightMinor === 0 || BigInt(leftMinor) !== -BigInt(rightMinor)) continue;
      const daysApart = Math.abs(
        Date.parse(`${left.posted_date}T00:00:00.000Z`)
        - Date.parse(`${right.posted_date}T00:00:00.000Z`),
      ) / 86_400_000;
      if (daysApart <= 2) {
        toTag.add(left.id);
        toTag.add(right.id);
        break;
      }
    }
  }

  if (toTag.size === 0) return null;
  const { error: updateError } = await admin
    .from("fund_bank_transactions")
    .update({ is_transfer: true })
    .in("id", [...toTag]);
  return updateError ? "PLAID_TRANSFER_TAG_PERSIST_FAILED" : null;
}
