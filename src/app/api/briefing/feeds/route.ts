import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { query } = await req.json();
  if (!query?.trim()) return NextResponse.json({ feeds: [] });

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Suggest 5 high-quality RSS/Atom feeds for the topic: "${query}". Return JSON array: [{name, url, description}] where url is the actual RSS feed URL (ending in .rss, /feed, /rss, or /atom). Only include real, well-known sources. No explanation.`,
      }],
    });

    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const match = text.match(/\[[\s\S]*\]/);
    const feeds = match ? JSON.parse(match[0]) : [];
    return NextResponse.json({ feeds });
  } catch {
    // Anthropic call failed (missing/invalid key, rate limit, network) or the
    // response didn't parse — surface a 200 with an error flag so the client's
    // `if (res.ok)` path still runs and can show a toast instead of going silent.
    return NextResponse.json({ feeds: [], error: "AI suggestion failed" }, { status: 200 });
  }
}
