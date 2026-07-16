"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
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

export function isRoutineResumeUrl(value: unknown): value is string {
  return typeof value === "string" &&
    /^\/api\/routines\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/resume$/i.test(value);
}

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
   * Run WebAuthn step-up for a step-up-required approval. Passkey assertion is
   * the ONLY way step_up_verified_at gets set (server-enforced). Returns { ok }
   * plus a reason (incl. "Cancelled" / "NO_PASSKEY") on failure.
   */
  const stepUp = useCallback(async (id: string): Promise<{ ok: boolean; reason?: string }> => {
    const optRes = await fetch(`/api/approvals/${id}/step-up?action=options`).catch(() => null);
    if (!optRes?.ok) {
      const body = (await optRes?.json().catch(() => ({}))) as { error?: string };
      return { ok: false, reason: body?.error ?? "OPTIONS_FAILED" };
    }
    const { options, ceremonyId } = (await optRes.json()) as {
      options?: PublicKeyCredentialRequestOptionsJSON;
      ceremonyId?: string;
    };
    if (!options || !ceremonyId) {
      return { ok: false, reason: "INVALID_OPTIONS" };
    }
    let assertion;
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      assertion = await startAuthentication({ optionsJSON: options });
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      return { ok: false, reason: /cancel|abort|not allowed/.test(msg) ? "Cancelled" : "CEREMONY_FAILED" };
    }
    const verifyRes = await fetch(`/api/approvals/${id}/step-up?action=verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: assertion, ceremonyId }),
    }).catch(() => null);
    if (!verifyRes?.ok) {
      const body = (await verifyRes?.json().catch(() => ({}))) as { error?: string };
      return { ok: false, reason: body?.error ?? "VERIFY_FAILED" };
    }
    const data = (await verifyRes.json()) as { stepUpVerifiedAt?: string };
    setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, step_up_verified_at: data.stepUpVerifiedAt ?? new Date().toISOString() } : a)));
    return { ok: true };
  }, []);

  /**
   * Decide an approval. Returns { ok } plus a reason on failure so the card can
   * distinguish an expired/not-actionable/step-up conflict (409) from a
   * network/server error.
   */
  const decide = useCallback(
    async (
      id: string,
      action: ApprovalDecision,
    ): Promise<{ ok: boolean; reason?: string; missing?: string[] }> => {
      const res = await fetch(`/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).catch(() => null);
      if (!res) return { ok: false, reason: "NETWORK" };
      if (res.ok) {
        const data = await res.json();
        const updated = data.approval as ApprovalRecord | undefined;
        if (updated) setApprovals((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)));
        return { ok: true };
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        missing?: string[];
        resumeUrl?: string;
      };
      if (
        action === "execute" &&
        body.error === "ROUTINE_RESUME_REQUIRED" &&
        isRoutineResumeUrl(body.resumeUrl)
      ) {
        const resumeResponse = await fetch(body.resumeUrl, { method: "POST" }).catch(() => null);
        if (!resumeResponse) return { ok: false, reason: "NETWORK" };
        if (resumeResponse.ok) {
          await reload();
          return { ok: true };
        }
        const resumeBody = (await resumeResponse.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        return {
          ok: false,
          reason: resumeBody.reason ?? resumeBody.error ?? "RUN_RESUME_FAILED",
        };
      }
      return { ok: false, reason: body.reason ?? body.error, missing: body.missing };
    },
    [reload],
  );

  return { approvals, loading, error, reload, decide, stepUp };
}
