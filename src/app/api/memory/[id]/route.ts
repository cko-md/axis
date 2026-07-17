import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { memoryUpdateSchema } from "@/lib/memory/contracts";

const SELECT_COLUMNS = "id, kind, scope, content, source_type, source_ref, confidence_bps, status, expires_at, archived_at, created_at, updated_at";
const idSchema = z.string().uuid();

type Context = { params: Promise<{ id: string }> };
type OwnedContext =
  | { response: NextResponse; id?: never; supabase?: never; user?: never }
  | { response?: never; id: string; supabase: Awaited<ReturnType<typeof createClient>>; user: { id: string } };

async function getOwnedContext(context: Context): Promise<OwnedContext> {
  const { id } = await context.params;
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { response: NextResponse.json({ error: "INVALID_MEMORY_ID" }, { status: 400 }) };
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return { response: NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }) };
  return { id: parsedId.data, supabase, user };
}

export async function PATCH(request: NextRequest, context: Context) {
  const owned = await getOwnedContext(context);
  if (owned.response) return owned.response;
  const body = await request.json().catch(() => null);
  const parsed = memoryUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "INVALID_MEMORY" }, { status: 400 });

  const now = new Date().toISOString();
  const statusPatch = parsed.data.status
    ? { status: parsed.data.status, archived_at: parsed.data.status === "archived" ? now : null }
    : {};
  const fields = { ...parsed.data };
  delete fields.status;
  const { data, error } = await owned.supabase
    .from("memory_items")
    .update({ ...fields, ...statusPatch, updated_at: now })
    .eq("id", owned.id)
    .eq("user_id", owned.user.id)
    .select(SELECT_COLUMNS)
    .maybeSingle();
  if (error) {
    captureRouteError(error, { route: "memory.item", operation: "update", area: "memory", status: 500, code: "MEMORY_UPDATE_FAILED" });
    return NextResponse.json({ error: "MEMORY_UPDATE_FAILED" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "MEMORY_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ item: data });
}

export async function DELETE(_request: NextRequest, context: Context) {
  const owned = await getOwnedContext(context);
  if (owned.response) return owned.response;
  const now = new Date().toISOString();
  const { data, error } = await owned.supabase
    .from("memory_items")
    .update({ status: "archived", archived_at: now, updated_at: now })
    .eq("id", owned.id)
    .eq("user_id", owned.user.id)
    .select(SELECT_COLUMNS)
    .maybeSingle();
  if (error) {
    captureRouteError(error, { route: "memory.item", operation: "archive", area: "memory", status: 500, code: "MEMORY_ARCHIVE_FAILED" });
    return NextResponse.json({ error: "MEMORY_ARCHIVE_FAILED" }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "MEMORY_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ item: data });
}
