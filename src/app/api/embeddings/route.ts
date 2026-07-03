import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "@/lib/ai/embed";
import { normalizeEmbeddingPayload } from "@/lib/ai/embeddingRequest";

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

  let rawPayload: unknown;
  try {
    rawPayload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const normalized = normalizeEmbeddingPayload(rawPayload);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: normalized.status });
  }
  const { noteId, text } = normalized.payload;

  const { data: note, error: noteError } = await supabase
    .from("notes")
    .select("id")
    .eq("id", noteId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (noteError) {
    Sentry.captureException(noteError, {
      tags: { area: "notes", op: "embedding_note_lookup", supabase_code: noteError.code ?? "unknown" },
      contexts: { note: { id: noteId } },
    });
    return NextResponse.json({ error: "Could not prepare note embedding." }, { status: 500 });
  }
  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  let embedding: number[];
  try {
    embedding = await embedText(text);
  } catch {
    Sentry.captureException(new Error("Note embedding generation failed"), {
      tags: { area: "notes", op: "embedding_generate", provider: "gemini" },
      contexts: { note: { id: noteId } },
    });
    return NextResponse.json({ error: "Could not generate note embedding." }, { status: 502 });
  }

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
    Sentry.captureException(upsertError, {
      tags: { area: "notes", op: "embedding_upsert", supabase_code: upsertError.code ?? "unknown" },
      contexts: { note: { id: noteId } },
    });
    return NextResponse.json({ error: "Could not save note embedding." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
