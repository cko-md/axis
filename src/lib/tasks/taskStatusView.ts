/**
 * Presentation mapping for agent-Task statuses — pure, so the workbench stays a
 * thin renderer and the labels/tones/grouping are unit-tested.
 */

import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  WAITING_STATUSES,
  type FinancialTaskStatus,
} from "./taskState";
import { semanticToneColor } from "@/lib/design/statusTokens";

/** Coarse tone used to color a status chip. */
export type TaskStatusTone = "neutral" | "active" | "waiting" | "blocked" | "done" | "failed";

/** Coarse grouping used by the workbench filter. */
export type TaskStatusGroup = "queued" | "active" | "waiting" | "blocked" | "done";

const LABELS: Readonly<Record<FinancialTaskStatus, string>> = {
  queued: "Queued",
  gathering_data: "Gathering data",
  researching: "Researching",
  calculating: "Calculating",
  waiting_for_data: "Waiting for data",
  waiting_for_user: "Waiting on you",
  waiting_for_approval: "Waiting for approval",
  executing: "Executing",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Human label for a status. */
export function taskStatusLabel(status: FinancialTaskStatus): string {
  return LABELS[status];
}

/** Chip tone for a status. */
export function taskStatusTone(status: FinancialTaskStatus): TaskStatusTone {
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "blocked") return "blocked";
  if ((ACTIVE_STATUSES as readonly string[]).includes(status)) return "active";
  if ((WAITING_STATUSES as readonly string[]).includes(status)) return "waiting";
  return "neutral"; // queued
}

/** Coarse group for the workbench filter. */
export function taskStatusGroup(status: FinancialTaskStatus): TaskStatusGroup {
  if (TERMINAL_STATUSES.has(status)) return "done";
  if (status === "blocked") return "blocked";
  if ((WAITING_STATUSES as readonly string[]).includes(status)) return "waiting";
  if ((ACTIVE_STATUSES as readonly string[]).includes(status)) return "active";
  return "queued";
}

/** CSS var for a tone, via the shared semantic status tokens. */
export function taskToneColor(tone: TaskStatusTone): string {
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
