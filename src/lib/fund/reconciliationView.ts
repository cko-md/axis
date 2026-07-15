/**
 * Pure presenter for {@link ReconciliationState} — maps the domain state to a
 * label, semantic tone, and screen-reader description for the holdings table
 * indicator. View logic only (mirrors taskStatusView/freshnessBadge): the
 * classification itself happens in reconcileHoldings.ts.
 */

import { semanticToneColor, type SemanticToneKey } from "@/lib/design/statusTokens";
import type { ReconciliationState } from "./provenance";

export type ReconciliationView = {
  label: string;
  tone: SemanticToneKey;
  /** Color resolved through the semantic status tokens. */
  color: string;
  /** Full sentence for aria-label / tooltips. */
  description: string;
};

const VIEWS: Record<ReconciliationState, Omit<ReconciliationView, "color">> = {
  matched: {
    label: "Reconciled",
    tone: "success",
    description: "Sources agree on this position to the cent.",
  },
  conflicting: {
    label: "Conflict",
    tone: "danger",
    description: "Sources disagree on this position — review before trusting the total.",
  },
  partial: {
    label: "Partial",
    tone: "warning",
    description: "Only one of the expected sources reported this position.",
  },
  missing: {
    label: "Missing",
    tone: "warning",
    description: "Neither source reported a value for this position.",
  },
  stale: {
    label: "Stale",
    tone: "danger",
    description: "The reconciled value is older than its freshness window.",
  },
  pending: {
    label: "Pending",
    tone: "muted",
    description: "Awaiting reconciliation (sources span currencies or a run has not completed).",
  },
};

/** View model for a reconciliation state; `null` state means render nothing. */
export function reconciliationView(state: ReconciliationState | null | undefined): ReconciliationView | null {
  if (state == null) return null;
  const view = VIEWS[state];
  if (!view) return null;
  return { ...view, color: semanticToneColor(view.tone) };
}
