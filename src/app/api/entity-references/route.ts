import { NextRequest, NextResponse } from "next/server";
import { createEntityReferenceSchema } from "@/lib/entities/api";
import { resolveEntity } from "@/lib/entities/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = createEntityReferenceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REFERENCE" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const [source, target] = await Promise.all([
    resolveEntity(supabase, user.id, parsed.data.source),
    resolveEntity(supabase, user.id, parsed.data.target),
  ]);
  if (!source.ok || !target.ok) {
    const unavailable = [source, target].find(
      (result) => !result.ok && result.error.code === "UNAVAILABLE",
    );
    if (unavailable && !unavailable.ok) {
      captureRouteError(new Error("Entity reference ownership check unavailable"), {
        route: "entity-references",
        operation: "resolve",
        area: "workspace",
        status: 503,
        code: unavailable.error.providerCode ?? unavailable.error.code,
      });
      return NextResponse.json({ error: "ENTITY_UNAVAILABLE" }, { status: 503 });
    }
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const { data: referenceId, error } = await supabase.rpc("create_entity_reference", {
    p_source_kind: parsed.data.source.kind,
    p_source_id: parsed.data.source.id,
    p_target_kind: parsed.data.target.kind,
    p_target_id: parsed.data.target.id,
    p_relation: parsed.data.relation,
    ...(parsed.data.label ? { p_label: parsed.data.label } : {}),
  });
  if (error) {
    const notFound = error.code === "P0002";
    if (!notFound) {
      captureRouteError(new Error("Entity reference persistence failed"), {
        route: "entity-references",
        operation: "create",
        area: "workspace",
        status: 500,
        code: error.code,
        tags: { source_kind: parsed.data.source.kind, target_kind: parsed.data.target.kind },
      });
    }
    return NextResponse.json({ error: notFound ? "NOT_FOUND" : "REFERENCE_WRITE_FAILED" }, { status: notFound ? 404 : 500 });
  }

  return NextResponse.json({ id: referenceId }, { status: 201 });
}
