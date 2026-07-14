/**
 * Pure presentation helpers for the approval card (§11.3). Kept out of the
 * component so the labels, tones, and money/scope formatting are unit-tested and
 * the card stays a thin renderer.
 */

import type { ActionClass } from "./actionPolicy";
import type { ApprovalAmount } from "./approvalRequest";
import { semanticToneColor } from "@/lib/design/statusTokens";

export type ApprovalTone = "neutral" | "caution" | "negative";

const ACTION_CLASS_LABELS: Readonly<Record<ActionClass, string>> = {
  READ: "Read",
  DRAFT: "Draft",
  SIMULATE: "Simulate",
  INTERNAL_WRITE: "Internal write",
  EXTERNAL_COMMUNICATION: "External communication",
  FINANCIAL_EXECUTION: "Financial execution",
  DESTRUCTIVE_ADMIN: "Destructive admin",
};

export function actionClassLabel(cls: ActionClass): string {
  return ACTION_CLASS_LABELS[cls];
}

export function actionClassTone(cls: ActionClass): ApprovalTone {
  if (cls === "FINANCIAL_EXECUTION" || cls === "DESTRUCTIVE_ADMIN") return "negative";
  if (cls === "EXTERNAL_COMMUNICATION" || cls === "INTERNAL_WRITE") return "caution";
  return "neutral";
}

export function approvalToneColor(tone: ApprovalTone): string {
  switch (tone) {
    case "negative":
      return semanticToneColor("danger");
    case "caution":
      return semanticToneColor("warning");
    default:
      return semanticToneColor("muted");
  }
}

/** Format an approval amount as e.g. "$1,899.50 · 10 units". */
export function formatApprovalAmount(amount: ApprovalAmount | undefined): string | null {
  if (!amount || !Number.isFinite(amount.value)) return null;
  let money: string;
  try {
    money = new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency }).format(
      amount.value,
    );
  } catch {
    // Unknown/invalid currency code — fall back to a plain number + code.
    money = `${amount.value.toFixed(2)} ${amount.currency}`;
  }
  return amount.quantity != null ? `${money} · ${amount.quantity} units` : money;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "executed";

const STATUS_LABELS: Readonly<Record<ApprovalStatus, string>> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  executed: "Executed",
};

export function approvalStatusLabel(status: ApprovalStatus): string {
  return STATUS_LABELS[status];
}
