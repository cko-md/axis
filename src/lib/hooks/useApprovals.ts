"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionClass, ApprovalRequirement } from "@/lib/security/actionPolicy";
import type { StoredProposedAction } from "@/lib/security/approvalPersistence";
import type { ApprovalStatus } from "@/lib/security/approvalCardView";

/** An approval as returned by GET /api/approvals. */
export type ApprovalRecord = {
  id: string;
  task_id: string | null;
  action_class: ActionClass;
  requirement: ApprovalRequirement;
  reasons: string[];
  proposed_action: StoredProposedAction;
  status: ApprovalStatus;
  step_up_verified_at?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  scope: "one_time" | "persistent";
  created_at: string;
};

export type ApprovalDecision = "approve" | "deny" | "execute";

export function useApprovals(statusFilter?: ApprovalStatus) {
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = statusFilter ? `/api/approvals?status=${statusFilter}` : "/api/approvals";
      const res = await fetch(url);
      if (res.status === 401) {
        setApprovals([]);
        setError("SIGNED_OUT");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setApprovals(Array.isArray(data.approvals) ? data.approvals : []);
    } catch {
      setError("LOAD_FAILED");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Decide an approval. Returns { ok } plus a reason on failure so the card can
   * distinguish an expired/not-actionable/step-up conflict (409) from a
   * network/server error.
   */
  const decide = useCallback(
    async (
      id: string,
      action: ApprovalDecision,
      stepUpVerified?: boolean,
    ): Promise<{ ok: boolean; reason?: string; missing?: string[] }> => {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, stepUpVerified }),
      }).catch(() => null);
      if (!res) return { ok: false, reason: "NETWORK" };
      if (res.ok) {
        const data = await res.json();
        const updated = data.approval as ApprovalRecord | undefined;
        if (updated) setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)));
        return { ok: true };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; missing?: string[] };
      return { ok: false, reason: body.reason ?? body.error, missing: body.missing };
    },
    [],
  );

  return { approvals, loading, error, reload, decide };
}
