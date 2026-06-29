import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";
import { aiJSON, type AIProviderPref } from "@/lib/ai/router";

type FeedSuggestion = { name: string; url: string; description: string };

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { query } = await req.json();
  if (!query?.trim()) return NextResponse.json({ feeds: [] });

  const { data: profile } = await supabase.from("profiles").select("ai_provider").eq("id", user.id).maybeSingle();
  const providerPref = (profile?.ai_provider as AIProviderPref) ?? "gemini";

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    // aiJSON spreads the parsed JSON onto an object — asking for a bare array
    // would corrupt it into {0:.., 1:.., _model}. Request a wrapper object
    // instead, matching every other aiJSON consumer in this codebase.
    const result = await aiJSON<{ feeds: FeedSuggestion[] }>({
      mode: "feed-discovery",
      anthropic,
      providerPref,
      system: 'Suggest 5 high-quality RSS/Atom feeds for a given topic. Return ONLY a JSON object with key "feeds": an array of objects, each {name, url, description}, where url is the actual RSS feed URL (ending in .rss, /feed, /rss, or /atom). Only include real, well-known sources. No markdown, no preamble.',
      userMessage: `topic: ${query}`,
      maxTokens: 500,
    });
    const feeds = Array.isArray(result.feeds) ? result.feeds : [];
    return NextResponse.json({ feeds });
  } catch {
    // AI call failed (missing/invalid key, rate limit, network) or the
    // response didn't parse — surface a 200 with an error flag so the client's
    // `if (res.ok)` path still runs and can show a toast instead of going silent.
    return NextResponse.json({ feeds: [], error: "AI suggestion failed" }, { status: 200 });
  }
}
