import { getWidgetDefinition } from "@/lib/widgets/registry";
import type { WidgetStatus } from "@/lib/widgets/types";

const TASK_RING_CIRCUMFERENCE = 175.9;

type WidgetRuntimeFlags = {
  loading?: boolean;
  error?: boolean;
  stale?: boolean;
  updatedAt?: string;
};

export function widgetRuntimeStatus(
  id: string,
  live: WidgetRuntimeFlags | undefined,
  catalogLive?: boolean,
): WidgetStatus {
  const definition = getWidgetDefinition(id);
  if (live?.loading && live.updatedAt) return "refreshing";
  if (live?.loading) return "loading";
  if (live?.error && live.stale) return "stale";
  if (live?.error) return "error";
  if (live?.stale) return "stale";
  if (live?.updatedAt) return "fresh";
  if (definition?.statusDefault) return definition.statusDefault;
  return catalogLive === false ? "lab" : "setup_required";
}

export function widgetLegacyStatusLabel(status: WidgetStatus) {
  if (status === "fresh") return "Fresh";
  if (status === "loading" || status === "refreshing") return "Refreshing";
  if (status === "stale") return "Stale";
  if (status === "error") return "Error";
  if (status === "lab") return "Lab";
  if (status === "disconnected") return "Disconnected";
  if (status === "empty") return "Empty";
  return "Setup";
}

export function taskRingProgress(tasks: Array<{ status: string }>) {
  const done = tasks.filter((task) => task.status === "done").length;
  const total = tasks.length;
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;

  return {
    done,
    total,
    label: total > 0 ? `${done} / ${total}` : "No tasks",
    strokeDashoffset: Math.round(TASK_RING_CIRCUMFERENCE * (1 - ratio)),
  };
}
