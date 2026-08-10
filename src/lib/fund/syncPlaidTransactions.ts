import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPlaidCreds, plaidHost, readBoundedPlaidJson } from "@/app/api/plaid/_lib";
import { categorizeProviderActivity } from "@/lib/fund/activityRules";
import {
  minorUnitsToDecimalString,
  normalizeFinancialCurrency,
  strictExactMinorUnits,
} from "@/lib/fund/financialTruth";
import { TRANSACTION_HISTORY_DAYS } from "@/lib/fund/transactionCoverage";
import { timedProviderFetch } from "@/lib/observability/providerTiming";

const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const MAX_RECORDS = PAGE_SIZE * MAX_PAGES;
const MAX_MUTATION_RESTARTS = 3;
const MAX_PAGE_RESPONSE_BYTES = 4 * 1024 * 1024;
const SYNC_DEADLINE_MS = 25_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

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
  const plaidCredentials = creds;

  const startedAt = Date.now();
  const deadline = startedAt + SYNC_DEADLINE_MS;
  const end = new Date(startedAt);
  const start = new Date(startedAt - TRANSACTION_HISTORY_DAYS * 86_400_000);
  const windowStart = start.toISOString().slice(0, 10);
  const windowEnd = end.toISOString().slice(0, 10);
  const generationId = crypto.randomUUID();
  async function fetchCompleteGeneration(): Promise<PlaidTxn[] | { error: string }> {
    for (let attempt = 0; attempt < MAX_MUTATION_RESTARTS; attempt++) {
      const transactions = new Map<string, PlaidTxn>();
      let cursor: string | null = null;
      let changeCount = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
      if (cancellationSignal?.aborted || Date.now() >= deadline) {
        return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
      }
      const remainingMs = Math.max(1, Math.min(10_000, deadline - Date.now()));
      const requestSignal = cancellationSignal
        ? AbortSignal.any([cancellationSignal, AbortSignal.timeout(remainingMs)])
        : AbortSignal.timeout(remainingMs);
      const response = await timedProviderFetch(
        `${plaidHost(plaidCredentials.env)}/transactions/sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: requestSignal,
          body: JSON.stringify({
            client_id: plaidCredentials.clientId,
            secret: plaidCredentials.secret,
            access_token: accessToken,
            count: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
            options: { include_personal_finance_category: true },
          }),
        },
        {
          area: "fund",
          provider: "plaid",
          operation: "sync_transactions",
          timeoutMs: 10_000,
          slowMs: 2_500,
          captureFailures: false,
        },
      ).catch(() => null);
      if (cancellationSignal?.aborted) return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
      if (!response?.ok) {
        const errorBody = response ? await readBoundedPlaidJson(response, MAX_PAGE_RESPONSE_BYTES) : null;
        if (errorBody?.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") break;
        return syncError("PLAID_TXN_FETCH_FAILED");
      }

      const body = await readBoundedPlaidJson(response, MAX_PAGE_RESPONSE_BYTES);
      if (cancellationSignal?.aborted) return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
      if (
        !body
        || !Array.isArray(body.added)
        || !Array.isArray(body.modified)
        || !Array.isArray(body.removed)
        || typeof body.has_more !== "boolean"
        || typeof body.next_cursor !== "string"
        || body.next_cursor.length < 1
        || body.next_cursor.length > 1_024
        || body.added.length + body.modified.length + body.removed.length > PAGE_SIZE
      ) return syncError("PLAID_INVALID_RESPONSE");
      const apply = (candidate: unknown) => {
        if (!candidate || typeof candidate !== "object") return false;
        const transactionId = (candidate as PlaidTxn).transaction_id;
        if (typeof transactionId !== "string" || !transactionId.trim()) return false;
        transactions.set(transactionId, candidate as PlaidTxn);
        return true;
      };
      for (const candidate of [...body.added, ...body.modified]) {
        if (!apply(candidate)) return syncError("PLAID_INVALID_RESPONSE");
      }
      for (const candidate of body.removed) {
        if (!candidate || typeof candidate !== "object") return syncError("PLAID_INVALID_RESPONSE");
        const transactionId = (candidate as { transaction_id?: unknown }).transaction_id;
        if (typeof transactionId !== "string" || !transactionId.trim()) return syncError("PLAID_INVALID_RESPONSE");
        transactions.delete(transactionId);
      }
      changeCount += body.added.length + body.modified.length + body.removed.length;
      if (changeCount > MAX_RECORDS || transactions.size > MAX_RECORDS) {
        return syncError("PLAID_TXN_RECORD_LIMIT_EXCEEDED");
      }
      cursor = body.next_cursor;
      if (!body.has_more) {
        return [...transactions.values()].filter((transaction) =>
          typeof transaction.date === "string"
          && transaction.date >= windowStart
          && transaction.date <= windowEnd,
        );
      }
      if (page === MAX_PAGES - 1) return syncError("PLAID_TXN_INCOMPLETE");
      }
      // Plaid requires restarting from the original cursor when a mutation
      // occurs during pagination. Starting without a cursor reconstructs the
      // full current Item generation; no mixed pages are ever published.
    }
    return syncError("PLAID_TXN_GENERATION_CHANGED");
  }
  const rawTransactions = await fetchCompleteGeneration();
  if ("error" in rawTransactions) return rawTransactions;
  if (cancellationSignal?.aborted || Date.now() >= deadline) {
    return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
  }

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
  const rpc = (admin as unknown as {
    rpc?: (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: unknown }>;
  }).rpc;
  if (typeof rpc !== "function") {
    return syncError("PLAID_TRANSACTION_ATOMIC_PUBLISH_UNAVAILABLE");
  }
  if (cancellationSignal?.aborted) return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
  const request = rpc.call(admin, "publish_fund_transaction_generation", {
    p_user_id: userId,
    p_connection_id: connectionId,
    p_window_start: windowStart,
    p_window_end: windowEnd,
    p_retrieved_at: retrievedAt,
    p_generation_id: generationId,
    p_rows: rows,
  });
  const abortable = request as typeof request & {
    abortSignal?: (signal: AbortSignal) => Promise<{ data: unknown; error: unknown }>;
  };
  let publication: { data: unknown; error: unknown };
  try {
    publication = cancellationSignal && typeof abortable.abortSignal === "function"
      ? await abortable.abortSignal(cancellationSignal)
      : await request;
  } catch {
    return cancellationSignal?.aborted
      ? syncError("PLAID_TXN_DEADLINE_EXCEEDED")
      : syncError("PLAID_TRANSACTION_PERSIST_FAILED");
  }
  if (cancellationSignal?.aborted) return syncError("PLAID_TXN_DEADLINE_EXCEEDED");
  const { data, error } = publication;
  if (error || !Array.isArray(data) || data.length !== 1) {
    return syncError("PLAID_TRANSACTION_PERSIST_FAILED");
  }
  const receipt = data[0] as Record<string, unknown>;
  return receipt.record_count === rows.length
    && typeof receipt.generation_hash === "string"
    && SHA256.test(receipt.generation_hash)
    ? { synced: rows.length }
    : syncError("PLAID_TRANSACTION_PERSIST_FAILED");
}
