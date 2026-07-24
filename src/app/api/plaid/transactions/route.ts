import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import {
  readCompleteTransactionRows,
  TRANSACTION_HISTORY_DAYS,
} from "@/lib/fund/transactionCoverage";
import { strictExactMinorUnits } from "@/lib/fund/financialTruth";

type StoredTransaction = {
  id: string;
  connection_id: string;
  generation_id: string;
  merchant_name: string | null;
  raw_name: string | null;
  custom_category: string | null;
  plaid_category: string | null;
  amount: unknown;
  iso_currency_code: string;
  posted_date: string;
  pending: boolean;
};

/** Legacy Fund-card endpoint backed by a proved-complete persisted generation. */
export async function POST() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try { supabase = await createClient(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try { authResult = await supabase.auth.getUser(); } catch {
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  const { data: { user }, error: authError } = authResult;
  if (authError) {
    captureRouteError(new Error("Plaid transaction authentication unavailable"), {
      route: "/api/plaid/transactions",
      operation: "authenticate",
      area: "fund",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return NextResponse.json({ error: "AUTH_UNAVAILABLE" }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - TRANSACTION_HISTORY_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const complete = await readCompleteTransactionRows<StoredTransaction>(
    supabase,
    user.id,
    start,
    today,
    "id, connection_id, generation_id, merchant_name, raw_name, custom_category, plaid_category, amount, iso_currency_code, posted_date, pending",
  );
  if (!complete) {
    return NextResponse.json(
      { configured: true, completeness: "unavailable", error: "TRANSACTION_HISTORY_UNAVAILABLE" },
      { status: 503 },
    );
  }

  const recentStart = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const completeRecent = complete.rows
    .filter((row) => row.posted_date >= recentStart && row.posted_date <= today)
    .sort((left, right) =>
      right.posted_date.localeCompare(left.posted_date) || left.id.localeCompare(right.id),
    );
  const transactions = completeRecent.slice(0, 50).map((row) => {
    const amountMinor = strictExactMinorUnits(row.amount, row.iso_currency_code);
    return {
      id: row.id,
      name: row.merchant_name ?? row.raw_name ?? "Transaction",
      category: row.custom_category ?? row.plaid_category ?? "OTHER",
      amountMinor,
      currency: row.iso_currency_code,
      date: row.posted_date,
      pending: row.pending,
    };
  });
  if (transactions.some((transaction) => transaction.amountMinor === null)) {
    return NextResponse.json(
      { configured: true, completeness: "unavailable", error: "TRANSACTION_AMOUNT_UNAVAILABLE" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    configured: true,
    completeness: "complete_source_page",
    transactions,
    page: {
      offset: 0,
      limit: 50,
      total: completeRecent.length,
      hasMore: completeRecent.length > 50,
    },
  });
}
