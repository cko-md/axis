import { NextRequest, NextResponse } from "next/server";
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

  const embedding = await embedText(q);

  const { data, error } = await supabase.rpc("search_note_embeddings", {
    p_embedding: embedding as unknown as string,
    p_limit: 8,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const matches = (data as Array<{ note_id: string; similarity: number }>) ?? [];
  if (matches.length === 0) return NextResponse.json({ results: [] });

  const { data: noteRows } = await supabase
    .from("notes")
    .select("id, title")
    .in("id", matches.map((m) => m.note_id));
  const titleById = new Map((noteRows ?? []).map((n) => [n.id, n.title as string]));

  // Defensive: drop any match that doesn't resolve to a real note (e.g. a
  // delete racing this request) rather than surfacing a dead link with no title.
  const results = matches
    .filter((m) => titleById.has(m.note_id))
    .map((m) => ({ ...m, title: titleById.get(m.note_id) }));

  return NextResponse.json({ results });
}
