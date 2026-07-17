import { NextRequest, NextResponse } from "next/server";
import { parseEntitySearchQuery } from "@/lib/entities/api";
import { compareRankedEntities, rankEntity } from "@/lib/entities/ranking";
import { entityRefKey } from "@/lib/entities/registry";
import { searchEntityCandidates } from "@/lib/entities/server";
import type { EntitySearchResponse, EntitySearchSource, EntityUsage } from "@/lib/entities/types";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "UNAUTHORIZED", message: "Sign in required." }, { status: 401 });
  }

  const parsed = parseEntitySearchQuery(request.nextUrl.searchParams);
  if (!parsed) {
    return NextResponse.json({ error: "INVALID_QUERY", message: "Use 2–120 characters and valid entity filters." }, { status: 400 });
  }

  const candidateResult = await searchEntityCandidates(supabase, user.id, {
    query: parsed.query,
    kinds: parsed.kinds,
    limitPerKind: Math.min(10, Math.max(3, Math.ceil(parsed.limit / parsed.kinds.length) * 2)),
  });

  const usageByRef = new Map<string, EntityUsage>();
  let usageUnavailable = false;
  if (candidateResult.candidates.length > 0) {
    const entityIds = [...new Set(candidateResult.candidates.map((candidate) => candidate.ref.id))];
    const { data: usageRows, error: usageError } = await supabase
      .from("entity_usage")
      .select("entity_kind, entity_id, direct_open_count, search_select_count, command_count, link_count, last_used_at, last_action")
      .eq("user_id", user.id)
      .in("entity_id", entityIds);
    if (usageError) {
      usageUnavailable = true;
      captureRouteError(new Error("Entity usage ranking unavailable"), {
        route: "entities.search",
        operation: "usage",
        area: "workspace",
        status: 503,
        code: typeof usageError.code === "string" ? usageError.code : "USAGE_UNAVAILABLE",
      });
    } else {
      for (const row of usageRows ?? []) {
        const useCount =
          row.direct_open_count + row.search_select_count + row.command_count + row.link_count;
        const ref = candidateResult.candidates.find(
          (candidate) => candidate.ref.kind === row.entity_kind && candidate.ref.id === row.entity_id,
        )?.ref;
        if (!ref) continue;
        usageByRef.set(entityRefKey(ref), {
          useCount,
          lastUsedAt: row.last_used_at,
          lastAction: row.last_action as EntityUsage["lastAction"],
        });
      }
    }
  }

  const results = candidateResult.candidates
    .map((entity) => ({
      ...entity,
      ranking: rankEntity(parsed.query, entity, usageByRef.get(entityRefKey(entity.ref))),
    }))
    .sort(compareRankedEntities)
    .slice(0, parsed.limit);

  const unavailableKinds = new Set(candidateResult.unavailable.map((failure) => failure.kind));
  for (const failure of candidateResult.unavailable) {
    captureRouteError(new Error("Entity search source unavailable"), {
      route: "entities.search",
      operation: "search",
      area: "workspace",
      status: 503,
      code: failure.providerCode ?? failure.code,
      tags: { entity_kind: failure.kind },
    });
  }

  const sources: EntitySearchSource[] = parsed.kinds.map((kind) => ({
    kind,
    status: unavailableKinds.has(kind) ? "unavailable" : "ok",
    count: results.filter((result) => result.ref.kind === kind).length,
    ...(unavailableKinds.has(kind) ? { code: "SOURCE_UNAVAILABLE" } : {}),
  }));
  sources.push({
    kind: "usage",
    status: usageUnavailable ? "unavailable" : "ok",
    count: usageByRef.size,
    ...(usageUnavailable ? { code: "USAGE_UNAVAILABLE" } : {}),
  });

  const response: EntitySearchResponse = {
    version: 1,
    results,
    sources,
    partial: candidateResult.unavailable.length > 0 || usageUnavailable,
  };
  return NextResponse.json(response);
}
