import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { EntityRef, EntitySummary } from "@/lib/entities/types";
import { entityNotFound, entityUnavailable, type EntityServerError } from "./errors";
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

type AxisSupabase = SupabaseClient<Database>;

export type EntityResolutionResult =
  | Readonly<{ ok: true; entity: EntitySummary }>
  | Readonly<{ ok: false; error: EntityServerError }>;

/** Exact server-side allowlists. Keep sensitive JSON and provider credentials out. */
export const ENTITY_SELECTS = Object.freeze({
  note: "id, title, folder, tags, updated_at",
  task: "id, objective, status, source_skill, updated_at",
  agenda_task: "id, title, status, priority, category, deadline, updated_at",
  person: "id, name, role, tag, last_contact_on, follow_up_on, updated_at",
  signal: "id, title, signal_type, source, read_at, routed_at, updated_at",
  approval: "id, action_class, requirement, status, scope, expires_at, created_at",
  routine_run:
    "id, routine_key, routine_version, status, trigger, started_at, completed_at",
  account: "id, provider, institution, mask, status, updated_at",
  holding:
    "symbol, name, shares, cost_basis, source, currency, reconciliation_state, retrieved_at, updated_at",
} as const);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLDING_ID_RE = /^[A-Z0-9.-]{1,32}$/;

function success(entity: EntitySummary): EntityResolutionResult {
  return { ok: true, entity };
}

function failure(error: EntityServerError): EntityResolutionResult {
  return { ok: false, error };
}

/**
 * Resolve one canonical entity using cached, owner-scoped Supabase data only.
 * This function never invokes a provider and never returns raw database errors.
 */
export async function resolveEntity(
  supabase: AxisSupabase,
  userId: string,
  ref: EntityRef,
): Promise<EntityResolutionResult> {
  if (!userId) return failure(entityUnavailable(ref.kind, "resolve", null));
  if (ref.kind !== "holding" && !UUID_RE.test(ref.id)) {
    return failure(entityNotFound(ref.kind));
  }

  try {
    switch (ref.kind) {
      case "note": {
        const { data, error } = await supabase
          .from("notes")
          .select(ENTITY_SELECTS.note)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectNote(data)) : failure(entityNotFound(ref.kind));
      }
      case "task": {
        const { data, error } = await supabase
          .from("agent_tasks")
          .select(ENTITY_SELECTS.task)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectTask(data)) : failure(entityNotFound(ref.kind));
      }
      case "agenda_task": {
        const { data, error } = await supabase
          .from("tasks")
          .select(ENTITY_SELECTS.agenda_task)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectAgendaTask(data)) : failure(entityNotFound(ref.kind));
      }
      case "person": {
        const { data, error } = await supabase
          .from("people")
          .select(ENTITY_SELECTS.person)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectPerson(data)) : failure(entityNotFound(ref.kind));
      }
      case "signal": {
        const { data, error } = await supabase
          .from("signals")
          .select(ENTITY_SELECTS.signal)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectSignal(data)) : failure(entityNotFound(ref.kind));
      }
      case "approval": {
        const { data, error } = await supabase
          .from("approvals")
          .select(ENTITY_SELECTS.approval)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectApproval(data)) : failure(entityNotFound(ref.kind));
      }
      case "routine_run": {
        const { data, error } = await supabase
          .from("routine_runs")
          .select(ENTITY_SELECTS.routine_run)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectRoutineRun(data)) : failure(entityNotFound(ref.kind));
      }
      case "account": {
        const { data, error } = await supabase
          .from("fund_connections")
          .select(ENTITY_SELECTS.account)
          .eq("user_id", userId)
          .eq("id", ref.id)
          .maybeSingle();
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        return data ? success(projectAccount(data)) : failure(entityNotFound(ref.kind));
      }
      case "holding": {
        const symbol = ref.id.trim().toUpperCase();
        if (!HOLDING_ID_RE.test(symbol)) return failure(entityNotFound(ref.kind));
        const { data, error } = await supabase
          .from("fund_holdings")
          .select(ENTITY_SELECTS.holding)
          .eq("user_id", userId)
          .ilike("symbol", symbol);
        if (error) return failure(entityUnavailable(ref.kind, "resolve", error));
        const entity = projectHoldingRows(
          (data ?? []).filter((row) => row.symbol.trim().toUpperCase() === symbol),
        )[0];
        return entity ? success(entity) : failure(entityNotFound(ref.kind));
      }
    }
  } catch (error) {
    return failure(entityUnavailable(ref.kind, "resolve", error));
  }
}
