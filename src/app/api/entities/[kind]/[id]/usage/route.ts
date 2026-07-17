import { NextRequest, NextResponse } from "next/server";
import { parseEntityPath, recordEntityUsageSchema } from "@/lib/entities/api";
import { resolveEntity } from "@/lib/entities/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ kind: string; id: string }> };

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { kind, id } = await context.params;
  const ref = parseEntityPath(kind, id);
  if (!ref) return NextResponse.json({ error: "INVALID_ENTITY_REF" }, { status: 400 });
  const body = recordEntityUsageSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "INVALID_USAGE_ACTION" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const resolved = await resolveEntity(supabase, user.id, ref);
  if (!resolved.ok) {
    if (resolved.error.code === "NOT_FOUND") return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    captureRouteError(new Error("Entity usage ownership check unavailable"), {
      route: "entities.usage",
      operation: "resolve",
      area: "workspace",
      status: 503,
      code: resolved.error.providerCode ?? resolved.error.code,
      tags: { entity_kind: ref.kind },
    });
    return NextResponse.json({ error: "ENTITY_UNAVAILABLE" }, { status: 503 });
  }

  const { error } = await supabase.rpc("record_entity_usage", {
    p_entity_kind: ref.kind,
    p_entity_id: ref.id,
    p_action: body.data.action,
  });
  if (error) {
    const notFound = error.code === "P0002";
    if (!notFound) {
      captureRouteError(new Error("Entity usage persistence failed"), {
        route: "entities.usage",
        operation: "record",
        area: "workspace",
        status: 500,
        code: error.code,
        tags: { entity_kind: ref.kind, usage_action: body.data.action },
      });
    }
    return NextResponse.json({ error: notFound ? "NOT_FOUND" : "USAGE_WRITE_FAILED" }, { status: notFound ? 404 : 500 });
  }
  return NextResponse.json({ recorded: true });
}
