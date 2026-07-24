import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";
import { readCompleteTransactionCoverage, TRANSACTION_HISTORY_DAYS } from "@/lib/fund/transactionCoverage";

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
  const limit = Math.min(Number(params.get("limit")) || 100, 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const today = new Date().toISOString().slice(0, 10);
  const coverageStart = from ?? new Date(
    Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000,
  ).toISOString().slice(0, 10);
  const coverageEnd = to ?? today;
  const coverage = await readCompleteTransactionCoverage(
    supabase,
    user.id,
    coverageStart,
    coverageEnd,
  );

  let query = supabase
    .from("fund_bank_transactions")
    .select("*", { count: "exact" })
    .eq("user_id", user.id)
    .order("posted_date", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) query = query.eq("custom_category", category);
  if (accountId) query = query.eq("account_id", accountId);
  if (reviewed === "true") query = query.eq("reviewed", true);
  if (reviewed === "false") query = query.eq("reviewed", false);
  if (from) query = query.gte("posted_date", from);
  if (to) query = query.lte("posted_date", to);
  if (!includeTransfers) query = query.eq("is_transfer", false);
  if (search) query = query.ilike("merchant_name", `%${search}%`);

  const { data, error, count } = await query;
  if (error) return redactRouteError(error, { route: "fund/bank-transactions", area: "fund" });
  const total = count ?? null;
  return NextResponse.json({
    transactions: data ?? [],
    completeness: coverage.available ? "complete_source_page" : "unavailable",
    verifiedEmpty: coverage.available && total === 0,
    page: {
      offset,
      limit,
      total,
      hasMore: total === null ? (data?.length ?? 0) === limit : offset + (data?.length ?? 0) < total,
    },
  });
}
