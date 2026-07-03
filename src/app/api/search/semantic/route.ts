import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/ai/embed";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing query param q" }, { status: 400 });
  }

  let embedding: number[];
  try {
    embedding = await embedText(q);
  } catch (err) {
    // Embeddings provider not configured (no GEMINI_API_KEY) → semantic search
    // is unavailable, not broken. Signal it distinctly so the UI can say so and
    // fall back to keyword search instead of showing a generic error.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("GEMINI_API_KEY is not set")) {
      return NextResponse.json(
        { error: "Semantic search is not configured.", code: "semantic_unavailable" },
        { status: 503 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error("Semantic search embedding failed"), {
      tags: { area: "notes", op: "semantic_search_embed", provider: "gemini" },
    });
    return NextResponse.json({ error: "Semantic search failed.", code: "semantic_error" }, { status: 502 });
  }

  const { data, error } = await supabase.rpc("search_note_embeddings", {
    p_embedding: embedding as unknown as string,
    p_limit: 8,
  });

  if (error) {
    Sentry.captureException(error, {
      tags: { area: "notes", op: "semantic_search_rpc", supabase_code: error.code ?? "unknown" },
    });
    return NextResponse.json({ error: "Semantic search failed.", code: "semantic_error" }, { status: 500 });
  }

  const matches = (data as Array<{ note_id: string; similarity: number }>) ?? [];
  if (matches.length === 0) return NextResponse.json({ results: [] });

  const { data: noteRows, error: notesError } = await supabase
    .from("notes")
    .select("id, title")
    .eq("user_id", user.id)
    .in("id", matches.map((m) => m.note_id));
  if (notesError) {
    Sentry.captureException(notesError, {
      tags: { area: "notes", op: "semantic_search_notes", supabase_code: notesError.code ?? "unknown" },
    });
    return NextResponse.json({ error: "Semantic search failed.", code: "semantic_error" }, { status: 500 });
  }
  const titleById = new Map((noteRows ?? []).map((n) => [n.id, n.title as string]));

  // Defensive: drop any match that doesn't resolve to a real note (e.g. a
  // delete racing this request) rather than surfacing a dead link with no title.
  const results = matches
    .filter((m) => titleById.has(m.note_id))
    .map((m) => ({ ...m, title: titleById.get(m.note_id) }));

  return NextResponse.json({ results });
}
