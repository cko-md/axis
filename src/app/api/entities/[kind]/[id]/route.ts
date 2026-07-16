import { NextRequest, NextResponse } from "next/server";
import { parseEntityPath } from "@/lib/entities/api";
import { resolveEntity } from "@/lib/entities/server";
import type {
  EntityPreviewPayload,
  EntityRef,
  EntityReference,
  ResolvedEntityReference,
} from "@/lib/entities/types";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ kind: string; id: string }> };

type ReferenceRow = {
  id: string;
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relation: string;
  label: string | null;
  origin: string;
  created_at: string;
};

function rowToReference(row: ReferenceRow): EntityReference {
  return {
    id: row.id,
    source: { kind: row.source_kind, id: row.source_id } as EntityRef,
    target: { kind: row.target_kind, id: row.target_id } as EntityRef,
    relation: row.relation as EntityReference["relation"],
    ...(row.label ? { label: row.label } : {}),
    origin: row.origin === "system" ? "system" : "user",
    createdAt: row.created_at,
  };
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { kind, id } = await context.params;
  const ref = parseEntityPath(kind, id);
  if (!ref) return NextResponse.json({ error: "INVALID_ENTITY_REF" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const resolved = await resolveEntity(supabase, user.id, ref);
  if (!resolved.ok) {
    if (resolved.error.code === "NOT_FOUND") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    captureRouteError(new Error("Entity preview unavailable"), {
      route: "entities.preview",
      operation: "resolve",
      area: "workspace",
      status: 503,
      code: resolved.error.providerCode ?? resolved.error.code,
      tags: { entity_kind: ref.kind },
    });
    return NextResponse.json({ error: "ENTITY_UNAVAILABLE" }, { status: 503 });
  }

  const [outgoingResult, backlinkResult] = await Promise.all([
    supabase
      .from("entity_references")
      .select("id, source_kind, source_id, target_kind, target_id, relation, label, origin, created_at")
      .eq("user_id", user.id)
      .eq("source_kind", ref.kind)
      .eq("source_id", ref.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("entity_references")
      .select("id, source_kind, source_id, target_kind, target_id, relation, label, origin, created_at")
      .eq("user_id", user.id)
      .eq("target_kind", ref.kind)
      .eq("target_id", ref.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const referencesUnavailable = Boolean(outgoingResult.error || backlinkResult.error);
  if (referencesUnavailable) {
    captureRouteError(new Error("Entity references unavailable"), {
      route: "entities.preview",
      operation: "references",
      area: "workspace",
      status: 503,
      code: outgoingResult.error?.code ?? backlinkResult.error?.code ?? "REFERENCES_UNAVAILABLE",
      tags: { entity_kind: ref.kind },
    });
  }

  const resolveReferences = async (
    rows: ReferenceRow[],
    direction: "outgoing" | "backlink",
  ): Promise<ResolvedEntityReference[]> => {
    const settled = await Promise.allSettled(
      rows.map(async (row) => {
        const reference = rowToReference(row);
        const relatedRef = direction === "outgoing" ? reference.target : reference.source;
        const related = await resolveEntity(supabase, user.id, relatedRef);
        return related.ok ? { ...reference, entity: related.entity, direction } : null;
      }),
    );
    return settled.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
  };

  const [outgoing, backlinks] = await Promise.all([
    resolveReferences((outgoingResult.data ?? []) as ReferenceRow[], "outgoing"),
    resolveReferences((backlinkResult.data ?? []) as ReferenceRow[], "backlink"),
  ]);

  const payload: EntityPreviewPayload = {
    entity: resolved.entity,
    outgoing,
    backlinks,
    referencesStatus: referencesUnavailable ? "unavailable" : "ok",
  };
  return NextResponse.json(payload);
}
