import { semanticToneColor } from "@/lib/design/statusTokens";

export type RoutineRunTone = "neutral" | "active" | "waiting" | "blocked" | "done" | "failed";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: "Queued",
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  blocked: "Blocked",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function routineRunStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? formatRoutineKey(status);
}

export function routineRunTone(status: string): RoutineRunTone {
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "partial" || status === "blocked") return "blocked";
  if (status === "waiting_for_approval") return "waiting";
  if (status === "running") return "active";
  return "neutral";
}

export function routineRunToneColor(tone: RoutineRunTone): string {
  switch (tone) {
    case "active":
      return semanticToneColor("accent");
    case "waiting":
      return semanticToneColor("warning");
    case "blocked":
      return semanticToneColor("alert");
    case "done":
      return semanticToneColor("success");
    case "failed":
      return semanticToneColor("danger");
    default:
      return semanticToneColor("muted");
  }
}

export function formatRoutineKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function summarizeRoutineOutput(output: unknown): string {
  if (!isRecord(output)) return "No output";
  const breaches = numberValue(output.breaches);
  const skipped = numberValue(output.skipped);
  const created = Array.isArray(output.created) ? output.created.length : undefined;
  const orders = Array.isArray(output.orders) ? output.orders.length : undefined;

  if (orders != null) return `${orders} order proposal${orders === 1 ? "" : "s"}`;
  if (created != null && created > 0) return `${created} task${created === 1 ? "" : "s"} created`;
  if (breaches != null && breaches > 0) return skipped != null && skipped > 0 ? `${breaches} breach${breaches === 1 ? "" : "es"} tracked` : `${breaches} breach${breaches === 1 ? "" : "es"}`;
  if (breaches === 0) return "No breaches";
  return "Output recorded";
}

export function jsonPreview(value: unknown, maxLength = 900): string {
  if (value == null) return "null";
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 14))}\n... truncated`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
