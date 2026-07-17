import type { VectorSyncState } from "@/lib/vector/types";
import styles from "./Vector.module.css";

const SYNC_LABELS: Record<VectorSyncState, string> = {
  "local-only": "Local only",
  pending: "Pending",
  syncing: "Syncing",
  synced: "Synced",
  conflict: "Conflict",
  error: "Error",
};

export function VectorSyncBadge({
  state,
  testId,
}: {
  state?: VectorSyncState;
  testId?: string;
}) {
  const label = state ? SYNC_LABELS[state] : "No record";
  return (
    <span
      className={styles.syncBadge}
      data-state={state ?? "none"}
      role="status"
      aria-label={`Save synchronization: ${label}`}
      data-testid={testId}
    >
      <span aria-hidden="true" />
      {label}
    </span>
  );
}
