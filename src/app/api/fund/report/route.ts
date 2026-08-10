import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { aiGenerate, type AIProviderPref } from "@/lib/ai/router";
import { optionalEnv } from "@/lib/env";
import {
  authoritativeMarketReportHoldings,
  marketReportInput,
  marketReportSources,
  MARKET_REPORT_SYSTEM,
} from "@/lib/fund/marketReport";
import { fetchNews, getPolygonApiKey } from "@/lib/massive/client";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";
import { resolveRouteIdentity } from "@/lib/auth/routeIdentity";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";

const ROUTE = "/api/fund/report";
const MAX_REPORT_VERIFICATION_ROWS = 512;

/**
 * Creates a persisted, cited research draft. Market sources are contextual
 * evidence only: the model cannot authorize an action or invent a value.
 */
export async function POST(request: NextRequest) {
  const identity = await resolveRouteIdentity(createClient, { route: ROUTE, area: "fund" });
  if (!identity.ok) return NextResponse.json({ error: identity.code }, { status: identity.status });
  const { client: supabase, user } = identity;
  const expectedSubject = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  if (expectedSubject && expectedSubject !== profileSubjectForUserId(user.id)) {
    return NextResponse.json({ error: "SUBJECT_CHANGED" }, { status: 409 });
  }

  const [holdingsResult, watchlistResult, profileResult, connectionsResult, coverageResult] = await Promise.all([
    supabase
      .from("fund_holdings")
      .select("symbol, name, shares, currency, authority, source, provider, provider_record_id, connection_id, retrieved_at, reconciliation_state, generation_id")
      .eq("user_id", user.id)
      .eq("authority", "provider")
      .limit(MAX_REPORT_VERIFICATION_ROWS + 1),
    supabase.from("fund_watchlist").select("symbol, name").eq("user_id", user.id).limit(5),
    supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle(),
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

  const readError = holdingsResult.error
    ?? watchlistResult.error
    ?? profileResult.error
    ?? connectionsResult.error
    ?? coverageResult.error;
  if (readError) {
    captureRouteError(readError, { route: ROUTE, operation: "read_research_context", area: "fund", status: 500 });
    return NextResponse.json({ error: "RESEARCH_CONTEXT_UNAVAILABLE" }, { status: 500 });
  }

  const candidateRows = holdingsResult.data ?? [];
  if (candidateRows.length > MAX_REPORT_VERIFICATION_ROWS) {
    return NextResponse.json({ error: "PORTFOLIO_CONTEXT_UNAVAILABLE", reason: "HOLDINGS_VERIFICATION_LIMIT_EXCEEDED" }, { status: 409 });
  }
  if ((connectionsResult.data ?? []).length > 32 || (coverageResult.data ?? []).length > 33) {
    return NextResponse.json({ error: "PORTFOLIO_CONTEXT_UNAVAILABLE", reason: "COVERAGE_VERIFICATION_LIMIT_EXCEEDED" }, { status: 409 });
  }
  // The query is provider-only; keep this defensive filter so a mocked or
  // drifted data boundary cannot let manual/legacy claims poison or enter the
  // verified provider generation.
  const candidateHoldings = candidateRows.filter((holding) => holding.authority === "provider");
  const portfolioContext = authoritativeMarketReportHoldings(
    candidateHoldings,
    connectionsResult.data ?? [],
    coverageResult.data ?? [],
  );
  const portfolioReason = portfolioContext.reason;
  if (portfolioReason) {
    return NextResponse.json({ error: "PORTFOLIO_CONTEXT_UNAVAILABLE", reason: portfolioReason }, { status: 409 });
  }
  const holdings = portfolioContext.holdings.slice(0, 10);
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
        portfolio_status: portfolioReason ?? "provider_verified",
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
