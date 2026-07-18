import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { redactRouteError } from "@/lib/observability/redactRouteError";

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

  let query = supabase
    .from("fund_bank_transactions")
    .select("*")
    .eq("user_id", user.id)
    .order("posted_date", { ascending: false })
    .limit(limit);

  if (category) query = query.eq("custom_category", category);
  if (accountId) query = query.eq("account_id", accountId);
  if (reviewed === "true") query = query.eq("reviewed", true);
  if (reviewed === "false") query = query.eq("reviewed", false);
  if (from) query = query.gte("posted_date", from);
  if (to) query = query.lte("posted_date", to);
  if (!includeTransfers) query = query.eq("is_transfer", false);
  if (search) query = query.ilike("merchant_name", `%${search}%`);

  const { data, error } = await query;
  if (error) return redactRouteError(error, { route: "fund/bank-transactions", area: "fund" });
  return NextResponse.json({ transactions: data ?? [] });
}
