import type { SupabaseClient } from "@supabase/supabase-js";
import { entityRefKey, searchableEntityKinds } from "@/lib/entities/registry";
import type { Database } from "@/lib/supabase/database.types";
import type { EntityKind, EntitySummary } from "@/lib/entities/types";
import { entityUnavailable, type EntityServerError } from "./errors";
import {
  projectAccount,
  projectAgendaTask,
  projectApproval,
  projectHoldingRows,
  projectNote,
  projectPerson,
  projectRoutineRun,
  projectSignal,
  projectTask,
} from "./projections";
import { ENTITY_SELECTS } from "./resolver";

type AxisSupabase = SupabaseClient<Database>;

export type EntityCandidateSearchOptions = Readonly<{
  query: string;
  kinds?: readonly EntityKind[];
  limitPerKind?: number;
}>;

export type EntityCandidateSearchResult = Readonly<{
  candidates: readonly EntitySummary[];
  unavailable: readonly EntityServerError[];
}>;

const MAX_QUERY_LENGTH = 120;
const DEFAULT_LIMIT_PER_KIND = 5;
const MAX_LIMIT_PER_KIND = 10;

/**
 * Convert user text into an ILIKE value without forwarding PostgREST filter
 * syntax. Separate words remain wildcard-separated so "routine run" matches
 * stored identifiers such as `routine_run`.
 */
export function toEntitySearchPattern(rawQuery: string): string | null {
  const words = rawQuery
    .normalize("NFKC")
    .slice(0, MAX_QUERY_LENGTH)
    .replace(/[%_\\(),]/g, " ")
    .replace(/[^\p{L}\p{N}.\-' ]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 ? `%${words.join("%")}%` : null;
}

function uniqueEntities(entities: readonly EntitySummary[]): EntitySummary[] {
  const byRef = new Map<string, EntitySummary>();
  for (const entity of entities) byRef.set(entityRefKey(entity.ref), entity);
  return [...byRef.values()];
}

async function loadCandidatesForKind(
  supabase: AxisSupabase,
  userId: string,
  kind: EntityKind,
  pattern: string,
  limit: number,
): Promise<EntitySummary[]> {
  switch (kind) {
    case "note": {
      const { data, error } = await supabase
        .from("notes")
        .select(ENTITY_SELECTS.note)
        .eq("user_id", userId)
        .ilike("title", pattern)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectNote);
    }
    case "task": {
      const { data, error } = await supabase
        .from("agent_tasks")
        .select(ENTITY_SELECTS.task)
        .eq("user_id", userId)
        .ilike("objective", pattern)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectTask);
    }
    case "agenda_task": {
      const { data, error } = await supabase
        .from("tasks")
        .select(ENTITY_SELECTS.agenda_task)
        .eq("user_id", userId)
        .ilike("title", pattern)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectAgendaTask);
    }
    case "person": {
      const { data, error } = await supabase
        .from("people")
        .select(ENTITY_SELECTS.person)
        .eq("user_id", userId)
        .ilike("name", pattern)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectPerson);
    }
    case "signal": {
      const { data, error } = await supabase
        .from("signals")
        .select(ENTITY_SELECTS.signal)
        .eq("user_id", userId)
        .ilike("title", pattern)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectSignal);
    }
    case "approval": {
      const { data, error } = await supabase
        .from("approvals")
        .select(ENTITY_SELECTS.approval)
        .eq("user_id", userId)
        .ilike("action_class", pattern)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectApproval);
    }
    case "routine_run": {
      const { data, error } = await supabase
        .from("routine_runs")
        .select(ENTITY_SELECTS.routine_run)
        .eq("user_id", userId)
        .ilike("routine_key", pattern)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(projectRoutineRun);
    }
    case "account": {
      const [institutionResult, providerResult] = await Promise.all([
        supabase
          .from("fund_connections")
          .select(ENTITY_SELECTS.account)
          .eq("user_id", userId)
          .ilike("institution", pattern)
          .order("updated_at", { ascending: false })
          .limit(limit),
        supabase
          .from("fund_connections")
          .select(ENTITY_SELECTS.account)
          .eq("user_id", userId)
          .ilike("provider", pattern)
          .order("updated_at", { ascending: false })
          .limit(limit),
      ]);
      if (institutionResult.error) throw institutionResult.error;
      if (providerResult.error) throw providerResult.error;
      return uniqueEntities(
        [...(institutionResult.data ?? []), ...(providerResult.data ?? [])]
          .map(projectAccount),
      ).slice(0, limit);
    }
    case "holding": {
      // Discover canonical symbols first, then load every local provider row
      // for each match. A row limit must never silently truncate an aggregate.
      const rowLimit = limit * 4;
      const [symbolResult, nameResult] = await Promise.all([
        supabase
          .from("fund_holdings")
          .select(ENTITY_SELECTS.holding)
          .eq("user_id", userId)
          .ilike("symbol", pattern)
          .order("updated_at", { ascending: false })
          .limit(rowLimit),
        supabase
          .from("fund_holdings")
          .select(ENTITY_SELECTS.holding)
          .eq("user_id", userId)
          .ilike("name", pattern)
          .order("updated_at", { ascending: false })
          .limit(rowLimit),
      ]);
      if (symbolResult.error) throw symbolResult.error;
      if (nameResult.error) throw nameResult.error;
      const symbols = new Set<string>();
      for (const row of [...(symbolResult.data ?? []), ...(nameResult.data ?? [])]) {
        const symbol = row.symbol.trim().toUpperCase();
        if (symbol) symbols.add(symbol);
      }
      const selectedSymbols = [...symbols].slice(0, limit);
      const detailResults = await Promise.all(
        selectedSymbols.map((symbol) =>
          supabase
            .from("fund_holdings")
            .select(ENTITY_SELECTS.holding)
            .eq("user_id", userId)
            .ilike("symbol", symbol),
        ),
      );
      const rows = [] as NonNullable<(typeof detailResults)[number]["data"]>;
      detailResults.forEach((result) => {
        if (result.error) throw result.error;
        rows.push(...(result.data ?? []));
      });
      return projectHoldingRows(rows);
    }
  }
}

/**
 * Read search candidates from local Supabase state. Tables are independent: a
 * failed source produces an explicit `unavailable` entry while healthy sources
 * still return results, allowing routes to surface an incomplete-search state.
 */
export async function searchEntityCandidates(
  supabase: AxisSupabase,
  userId: string,
  options: EntityCandidateSearchOptions,
): Promise<EntityCandidateSearchResult> {
  const pattern = toEntitySearchPattern(options.query);
  if (!pattern) return { candidates: [], unavailable: [] };

  const requestedKinds = options.kinds ?? searchableEntityKinds();
  const kinds = [...new Set(requestedKinds)];
  const limit = Math.min(
    MAX_LIMIT_PER_KIND,
    Math.max(1, Math.floor(options.limitPerKind ?? DEFAULT_LIMIT_PER_KIND)),
  );
  if (!userId) {
    return {
      candidates: [],
      unavailable: kinds.map((kind) => entityUnavailable(kind, "search", null)),
    };
  }

  const settled = await Promise.allSettled(
    kinds.map((kind) => loadCandidatesForKind(supabase, userId, kind, pattern, limit)),
  );
  const candidates: EntitySummary[] = [];
  const unavailable: EntityServerError[] = [];
  settled.forEach((result, index) => {
    const kind = kinds[index];
    if (result.status === "fulfilled") candidates.push(...result.value);
    else unavailable.push(entityUnavailable(kind, "search", result.reason));
  });

  return { candidates: uniqueEntities(candidates), unavailable };
}
