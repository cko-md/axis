import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { MEMORY_STATUSES, memoryCreateSchema } from "@/lib/memory/contracts";

const SELECT_COLUMNS = "id, kind, scope, content, source_type, source_ref, confidence_bps, status, expires_at, archived_at, created_at, updated_at";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const status = request.nextUrl.searchParams.get("status") ?? "active";
  if (status !== "all" && !MEMORY_STATUSES.includes(status as (typeof MEMORY_STATUSES)[number])) {
    return NextResponse.json({ error: "INVALID_STATUS" }, { status: 400 });
  }

  let query = supabase
    .from("memory_items")
    .select(SELECT_COLUMNS)
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    captureRouteError(error, { route: "memory", operation: "list", area: "memory", status: 500, code: "MEMORY_LIST_FAILED" });
    return NextResponse.json({ error: "MEMORY_LIST_FAILED" }, { status: 500 });
  }
  return NextResponse.json({ items: data ?? [] });
}
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = memoryCreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "INVALID_MEMORY" }, { status: 400 });

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("memory_items")
    .insert({
      user_id: user.id,
      ...parsed.data,
      source_type: "user_asserted",
      source_ref: null,
      status: "active",
      archived_at: null,
      updated_at: now,
    })
    .select(SELECT_COLUMNS)
    .single();
  if (error || !data) {
    captureRouteError(error, { route: "memory", operation: "create", area: "memory", status: 500, code: "MEMORY_CREATE_FAILED" });
    return NextResponse.json({ error: "MEMORY_CREATE_FAILED" }, { status: 500 });
  }
  return NextResponse.json({ item: data }, { status: 201 });
}
