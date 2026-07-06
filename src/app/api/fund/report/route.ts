import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { optionalEnv } from "@/lib/env";
import { getPolygonApiKey } from "@/lib/massive/client";

export async function POST() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: holdings } = await supabase
    .from("fund_holdings")
    .select("symbol, name, shares, cost_basis")
    .eq("user_id", user.id)
    .limit(10);

  const { data: watchlist } = await supabase
    .from("fund_watchlist")
    .select("symbol, name")
    .eq("user_id", user.id)
    .limit(5);

  // Polygon news for top holdings — POLYGON_API_KEY stays server-side only
  const polygonKey = getPolygonApiKey();
  let newsContext = "";
  if (polygonKey && holdings && holdings.length > 0) {
    const tickers = holdings
      .slice(0, 5)
      .map((h) => h.symbol)
      .join(",");
    try {
      const newsRes = await fetch(
        `https://api.polygon.io/v2/reference/news?ticker=${tickers}&limit=8&apiKey=${polygonKey}`,
        { cache: "no-store", signal: AbortSignal.timeout(4000) },
      );
      if (newsRes.ok) {
        const newsData = await newsRes.json();
        const headlines = (newsData.results ?? [])
          .slice(0, 6)
          .map(
            (n: { title: string; tickers?: string[] }) =>
              `- ${n.title} [${(n.tickers ?? []).slice(0, 2).join(", ")}]`,
          )
          .join("\n");
        if (headlines) newsContext = `\nRecent news:\n${headlines}`;
      }
    } catch {
      // Polygon unavailable — report still runs on holdings alone
    }
  }

  const holdingsSummary =
    holdings && holdings.length > 0
      ? holdings
          .map(
            (h) =>
              `${h.symbol} (${h.name ?? h.symbol}): ${h.shares} shares @ $${h.cost_basis ?? "?"}`,
          )
          .join("\n")
      : "No holdings on file. Generate a general market brief.";

  const watchSummary =
    watchlist && watchlist.length > 0
      ? `\nWatchlist: ${watchlist.map((w) => w.symbol).join(", ")}`
      : "";

  const apiKey = optionalEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "ANTHROPIC_API_KEY_NOT_CONFIGURED",
        message: "Set ANTHROPIC_API_KEY to enable AI market reports.",
      },
      { status: 503 },
    );
  }

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `You are a sell-side equity analyst writing a market brief for a physician-investor with a long-term growth bias. Portfolio:\n${holdingsSummary}${watchSummary}${newsContext}\n\nWrite a 3–4 sentence brief covering: (1) one portfolio-specific risk or opportunity right now, (2) a macro theme relevant to these positions, and (3) one concrete action or watchpoint. Be specific with numbers where possible. No disclaimers, no padding.`,
      },
    ],
  });

  const report = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  return NextResponse.json({ report });
}
