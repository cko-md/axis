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

export type WidgetTileActivation =
  | { kind: "navigate"; href: string; label: string }
  | { kind: "open-drawer"; label: string };

// How a Console widget tile responds to click / keyboard activation. Every
// registry widget MUST resolve to a real activation — a tile that can neither
// navigate to its module nor open a detail drawer is a "dead tile" (DISP-2).
// Returns null only for unknown ids or a mis-wired primary action, which the
// widget-grid-model guard test forbids for the shipped registry.
export function resolveWidgetTileActivation(id: string): WidgetTileActivation | null {
  const action = getWidgetDefinition(id)?.primaryAction;
  if (!action) return null;
  if (action.kind === "navigate" && action.href) {
    return { kind: "navigate", href: action.href, label: action.label };
  }
  if (action.kind === "open-drawer") {
    return { kind: "open-drawer", label: action.label };
  }
  return null;
}

export const CONSOLE_SECTION_DRILL_INS = {
  "dispatch-block": { href: "/dispatch", label: "Open Dispatch" },
  "todays-arc": { href: "/schedule", label: "Open Schedule" },
  "focus-ranked": { href: "/agenda", label: "Open Agenda" },
  "people-spotlight": { href: "/people", label: "Open People" },
  "markets-body": { href: "/fund/market", label: "Open Markets" },
  "daily-rings": { href: "/agenda", label: "Open Agenda" },
} as const;

export type ConsoleDrillInSection = keyof typeof CONSOLE_SECTION_DRILL_INS;
