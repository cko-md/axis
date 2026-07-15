"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Seg } from "@/components/ui/Seg";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { useApprovals, type ApprovalDecision } from "@/lib/hooks/useApprovals";
import type { ApprovalStatus } from "@/lib/security/approvalCardView";

type Filter = ApprovalStatus | "all";

const FILTERS: { label: string; value: Filter }[] = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Executed", value: "executed" },
  { label: "All", value: "all" },
];

const DECISION_ERRORS: Record<string, string> = {
  EXPIRED: "This approval has expired.",
  STEP_UP_REQUIRED: "Step-up verification is required before this can execute.",
  STEP_UP_STALE: "Your passkey verification expired — verify again to execute.",
  INCOMPLETE: "This approval is missing required details and can't execute.",
  NOT_APPROVED: "This approval hasn't been approved yet.",
  NOT_PENDING: "This approval has already been decided.",
};

export function ApprovalsModule() {
  const [filter, setFilter] = useState<Filter>("pending");
  const { approvals, loading, error, decide, stepUp } = useApprovals(filter === "all" ? undefined : filter);
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const onDecide = async (id: string, action: ApprovalDecision) => {
    setBusyId(id);
    const result = await decide(id, action);
    setBusyId(null);
    if (result.ok) {
      const verb = action === "approve" ? "Approved" : action === "deny" ? "Denied" : "Cleared to execute";
      toast(`${verb}.`, "success", "Approvals");
    } else {
      toast(
        (result.reason && DECISION_ERRORS[result.reason]) ?? "Could not update the approval.",
        "error",
        "Approvals",
      );
    }
  };

  const onStepUp = async (id: string) => {
    setBusyId(id);
    const result = await stepUp(id);
    setBusyId(null);
    if (result.ok) {
      toast("Identity verified.", "success", "Approvals");
    } else if (result.reason === "Cancelled") {
      // user aborted the ceremony — no error toast
    } else {
      toast(
        result.reason === "NO_PASSKEY"
          ? "No passkey registered. Add one in Control Room to approve financial actions."
          : "Passkey verification failed.",
        "error",
        "Approvals",
      );
    }
  };

  return (
    <div>
      <Card tick>
        <div className="seclabel">Approvals</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", margin: "4px 0 0", maxWidth: 640 }}>
          Every gated action the assistant proposes shows its full scope here — the exact action, target,
          amount, data freshness, and reasons — before you approve. Financial execution requires step-up
          verification, and nothing runs autonomously.
        </p>
      </Card>

      <div className="divider" />

      <div style={{ marginBottom: 12 }}>
        <Seg options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      {loading ? (
        <SkeletonCard rows={5} />
      ) : error === "SIGNED_OUT" ? (
        <StatusCallout kind="setup_required" title="Sign in to view approvals">
          Your approval queue is private to your account.
        </StatusCallout>
      ) : error ? (
        <StatusCallout kind="error" title="Couldn’t load approvals">
          Something went wrong. Reload to try again.
        </StatusCallout>
      ) : approvals.length === 0 ? (
        <StatusCallout kind="empty" title="Nothing to approve">
          {filter === "pending"
            ? "You’re all caught up — no actions are waiting on you."
            : "No approvals match this filter."}
        </StatusCallout>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16, alignItems: "start" }}>
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              busy={busyId === a.id}
              onDecide={(action) => void onDecide(a.id, action)}
              onStepUp={() => void onStepUp(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
