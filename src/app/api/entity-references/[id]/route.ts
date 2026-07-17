import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const parsedId = z.string().uuid().safeParse((await context.params).id);
  if (!parsedId.success) return NextResponse.json({ error: "INVALID_REFERENCE_ID" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const { data: exists, error: readError } = await supabase
    .from("entity_references")
    .select("id")
    .eq("user_id", user.id)
    .eq("id", parsedId.data)
    .maybeSingle();
  if (readError) {
    captureRouteError(new Error("Entity reference lookup failed"), {
      route: "entity-references",
      operation: "lookup",
      area: "workspace",
      status: 500,
      code: readError.code,
    });
    return NextResponse.json({ error: "REFERENCE_UNAVAILABLE" }, { status: 500 });
  }
  if (!exists) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const { data: deleted, error } = await supabase.rpc("delete_entity_reference", {
    p_reference_id: parsedId.data,
  });
  if (error) {
    captureRouteError(new Error("Entity reference delete failed"), {
      route: "entity-references",
      operation: "delete",
      area: "workspace",
      status: 500,
      code: error.code,
    });
    return NextResponse.json({ error: "REFERENCE_DELETE_FAILED" }, { status: 500 });
  }
  if (!deleted) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
