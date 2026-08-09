import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import {
  readCompleteTransactionRows,
  TRANSACTION_HISTORY_DAYS,
  type TransactionCoverageProof,
  TransactionCoverageInputError,
} from "@/lib/fund/transactionCoverage";

type BankTransactionRow = {
  id: string;
  connection_id: string;
  generation_id: string;
  posted_date: string;
  custom_category: string | null;
  account_id: string | null;
  reviewed: boolean;
  is_transfer: boolean;
  merchant_name: string | null;
  [key: string]: unknown;
};

/**
 * GET /api/fund/bank-transactions
 *
 * Persisted Plaid transactions (replaces the old live-fetch-only
 * /api/plaid/transactions for display purposes — that route still exists
 * for the raw Plaid pull itself, which finance-daily/webhook sync writes
 * here). Supports search/filter so the Spending module doesn't need to
 * paginate through raw Plaid responses client-side.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = request.nextUrl.searchParams;
  const category = params.get("category");
  const search = params.get("search");
  const accountId = params.get("accountId");
  const reviewed = params.get("reviewed");
  const includeTransfers = params.get("includeTransfers") === "true";
  const from = params.get("from");
  const to = params.get("to");
  const limit = Math.max(1, Math.min(Number(params.get("limit")) || 100, 500));
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const today = new Date().toISOString().slice(0, 10);
  const coverageStart = from ?? new Date(
    Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000,
  ).toISOString().slice(0, 10);
  const coverageEnd = to ?? today;
  let complete: { proof: TransactionCoverageProof; rows: BankTransactionRow[] } | null;
  try {
    complete = await readCompleteTransactionRows<BankTransactionRow>(
      supabase,
      user.id,
      coverageStart,
      coverageEnd,
      "*",
    );
  } catch (error) {
    if (error instanceof TransactionCoverageInputError) {
      return NextResponse.json({ error: "INVALID_QUERY" }, { status: 400 });
    }
    return redactRouteError(error, {
      route: "fund/bank-transactions",
      area: "fund",
    });
  }
  if (!complete) {
    return NextResponse.json({
      transactions: [],
      completeness: "unavailable",
      verifiedEmpty: false,
      page: { offset, limit, total: null, hasMore: false },
    });
  }
  const normalizedSearch = search?.toLocaleLowerCase() ?? null;
  const filtered = complete.rows
    .filter((row) => !category || row.custom_category === category)
    .filter((row) => !accountId || row.account_id === accountId)
    .filter((row) => reviewed !== "true" || row.reviewed)
    .filter((row) => reviewed !== "false" || !row.reviewed)
    .filter((row) => !from || row.posted_date >= from)
    .filter((row) => !to || row.posted_date <= to)
    .filter((row) => includeTransfers || !row.is_transfer)
    .filter((row) => !normalizedSearch || row.merchant_name?.toLocaleLowerCase().includes(normalizedSearch))
    .sort((left, right) =>
      right.posted_date.localeCompare(left.posted_date)
      || left.id.localeCompare(right.id),
    );
  const total = filtered.length;
  const transactions = filtered.slice(offset, offset + limit);
  return NextResponse.json({
    transactions,
    completeness: "complete_source_page",
    verifiedEmpty: total === 0,
    page: {
      offset,
      limit,
      total,
      hasMore: offset + transactions.length < total,
    },
  });
}
