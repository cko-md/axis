import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/ai/embed";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    noteId?: string;
    text?: string;
  };
  const { noteId, text } = body;

  if (!noteId || !text) {
    return NextResponse.json(
      { error: "Missing noteId or text" },
      { status: 400 },
    );
  }

  const embedding = await embedText(text);

  const { error: upsertError } = await supabase
    .from("note_embeddings")
    .upsert(
      {
        note_id: noteId,
        user_id: user.id,
        embedding: embedding as unknown as string,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "note_id" },
    );

  if (upsertError) {
    return NextResponse.json(
      { error: upsertError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
