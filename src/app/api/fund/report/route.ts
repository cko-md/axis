import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { aiGenerate, type AIProviderPref } from "@/lib/ai/router";
import { optionalEnv } from "@/lib/env";
import { marketReportInput, marketReportSources, MARKET_REPORT_SYSTEM } from "@/lib/fund/marketReport";
import { fetchNews, getPolygonApiKey } from "@/lib/massive/client";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

const ROUTE = "/api/fund/report";

/**
 * Creates a persisted, cited research draft. Market sources are contextual
 * evidence only: the model cannot authorize an action or invent a value.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const [holdingsResult, watchlistResult, profileResult] = await Promise.all([
    supabase.from("fund_holdings").select("symbol, name, shares, cost_basis").eq("user_id", user.id).limit(10),
    supabase.from("fund_watchlist").select("symbol, name").eq("user_id", user.id).limit(5),
    supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle(),
  ]);

  const readError = holdingsResult.error ?? watchlistResult.error ?? profileResult.error;
  if (readError) {
    captureRouteError(readError, { route: ROUTE, operation: "read_research_context", area: "fund", status: 500 });
    return NextResponse.json({ error: "RESEARCH_CONTEXT_UNAVAILABLE" }, { status: 500 });
  }

  const holdings = holdingsResult.data ?? [];
  const watchlist = watchlistResult.data ?? [];
  const symbols = [...new Set([...holdings, ...watchlist].map((item) => item.symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 8);

  let sources = [] as ReturnType<typeof marketReportSources>;
  let sourceStatus: "available" | "not_configured" | "unavailable" | "not_requested" = "not_requested";
  if (symbols.length > 0 && getPolygonApiKey()) {
    try {
      sources = marketReportSources(await fetchNews(symbols, 8));
      sourceStatus = "available";
    } catch (error) {
      sourceStatus = "unavailable";
      captureRouteError(error, {
        route: ROUTE,
        operation: "fetch_news_sources",
        area: "fund",
        provider: "polygon",
        status: 502,
        tags: { symbol_count: symbols.length },
      });
    }
  } else if (symbols.length > 0) {
    sourceStatus = "not_configured";
  }

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
  const providerPref = (profileResult.data?.ai_provider as AIProviderPref | null) ?? "auto";

  let generated: { text: string; model: string };
  try {
    generated = await aiGenerate({
      mode: "market-report",
      system: MARKET_REPORT_SYSTEM,
      userMessage: marketReportInput({
        holdings: holdings.map((holding) => ({
          symbol: holding.symbol,
          name: holding.name,
          shares: holding.shares,
          costBasis: holding.cost_basis,
        })),
        watchlist,
        sources,
      }),
      maxTokens: 350,
      temperature: 0.1,
      anthropic,
      providerPref,
    });
  } catch (error) {
    captureRouteError(error, { route: ROUTE, operation: "generate_report", area: "fund", provider: "ai", status: 503 });
    return NextResponse.json({ error: "REPORT_GENERATION_UNAVAILABLE" }, { status: 503 });
  }

  const { data: insight, error: insertError } = await supabase
    .from("ai_insights")
    .insert({
      user_id: user.id,
      kind: "market_report",
      title: "Market research brief",
      body: generated.text,
      data_used: {
        holdings: holdings.map((holding) => holding.symbol),
        watchlist: watchlist.map((item) => item.symbol),
        sources,
        source_status: sourceStatus,
        model: generated.model,
      },
      assumptions: "The draft is grounded only in the listed holdings, watchlist symbols, and cited market-source metadata. It is a review aid, not investment advice or an execution instruction.",
      confidence: sources.length > 0 ? "medium" : "low",
      requires_review: true,
    })
    .select()
    .single();

  if (insertError) {
    captureRouteError(insertError, { route: ROUTE, operation: "persist_report", area: "fund", status: 500 });
    return NextResponse.json({ error: "REPORT_PERSISTENCE_FAILED" }, { status: 500 });
  }

  return NextResponse.json({ insight });
}
