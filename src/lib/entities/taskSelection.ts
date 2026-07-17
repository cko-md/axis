import { parseEntityRef, serializeEntityRef } from "@/lib/entities/registry";
import type { EntityRef } from "@/lib/entities/types";

export type TaskSelection =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "pending"; ref: EntityRef & { kind: "task" } }>
  | Readonly<{ status: "not_found"; ref: EntityRef & { kind: "task" } }>
  | Readonly<{ status: "ready"; ref: EntityRef & { kind: "task" } }>;

/**
 * Resolve a Tasks workbench query against the IDs already returned by the
 * owner-scoped task list. This deliberately does not probe an unknown ID:
 * absent and foreign tasks therefore have the same not-found outcome.
 */
export function resolveTaskSelection(
  value: string | null,
  ownerTaskIds: readonly string[],
  ownerTasksLoaded: boolean,
): TaskSelection {
  if (value === null) return { status: "none" };

  const ref = parseEntityRef(value);
  if (!ref || ref.kind !== "task") return { status: "invalid" };

  const taskRef = ref as EntityRef & { kind: "task" };
  if (!ownerTasksLoaded) return { status: "pending", ref: taskRef };
  if (!ownerTaskIds.includes(taskRef.id)) return { status: "not_found", ref: taskRef };
  return { status: "ready", ref: taskRef };
}

/** Preserve workspace and unrelated query state while changing task focus. */
export function taskSelectionHref(
  pathname: string,
  currentQuery: string,
  taskId: string | null,
): string {
  const params = new URLSearchParams(currentQuery);
  if (taskId === null) {
    params.delete("task");
  } else {
    params.set("task", serializeEntityRef({ kind: "task", id: taskId }));
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
