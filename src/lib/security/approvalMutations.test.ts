import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  commitApprovalStepUp,
  consumeActionableApproval,
  consumeApprovalAuthenticationChallenge,
  createApprovalWithActivity,
  transitionApproval,
} from "./approvalMutations";

function client(data: unknown, error: unknown = null) {
  return {
    rpc: vi.fn(async () => ({ data, error })),
  } as unknown as SupabaseClient<Database>;
}

describe("atomic approval persistence", () => {
  it("returns only the unique transitioned row", async () => {
    const result = await transitionApproval({
      userId: "user_1",
      approvalId: "approval_1",
      expectedStatus: "pending",
      nextStatus: "approved",
    }, client({
      outcome: "updated",
      approval: { id: "approval_1", status: "approved", action_class: "INTERNAL_WRITE" },
    }));
    expect(result).toMatchObject({ ok: true, approval: { status: "approved" } });
  });

  it("reports the winner of a competing transition", async () => {
    const result = await transitionApproval({
      userId: "user_1",
      approvalId: "approval_1",
      expectedStatus: "pending",
      nextStatus: "denied",
    }, client({ outcome: "conflict", currentStatus: "approved" }));
    expect(result).toEqual({ ok: false, code: "CONFLICT", currentStatus: "approved" });
  });

  it("requires the service mutation boundary for atomic step-up commits", async () => {
    const result = await commitApprovalStepUp({
      userId: "user_1",
      approvalId: "approval_1",
      expectedApprovalStatus: "pending",
      passkeyId: "passkey_1",
      expectedCounter: 0,
      newCounter: 1,
      verifiedAt: "2026-07-16T00:00:00.000Z",
    }, null);
    expect(result).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
  });

  it("preserves routine ownership and step-up outcomes from execute-time validation", async () => {
    await expect(consumeActionableApproval({
      userId: "user_1",
      approvalId: "approval_1",
      now: "2026-07-16T00:00:00.000Z",
    }, client({ outcome: "routine_owned" }))).resolves.toEqual({
      ok: false,
      code: "ROUTINE_OWNED",
    });
    await expect(consumeActionableApproval({
      userId: "user_1",
      approvalId: "approval_1",
      now: "2026-07-16T00:00:00.000Z",
    }, client({ outcome: "step_up_stale" }))).resolves.toEqual({
      ok: false,
      code: "STEP_UP_STALE",
    });
    await expect(consumeActionableApproval({
      userId: "user_1",
      approvalId: "approval_1",
      now: "2026-07-16T00:00:00.000Z",
    }, client({ outcome: "not_actionable" }))).resolves.toEqual({
      ok: false,
      code: "NOT_ACTIONABLE",
    });
  });

  it("strictly parses atomic approval creation and one-time challenge consumption", async () => {
    const created = await createApprovalWithActivity({
      user_id: "user_1",
      task_id: null,
      action_class: "INTERNAL_WRITE",
      requirement: "approval",
      reasons: ["approval required"],
      proposed_action: {
        actor: { kind: "agent", id: "axis" },
        tool: "axis.update",
        summary: "Update",
        target: { entityType: "record" },
      },
      scope: "one_time",
      expires_at: null,
    }, client({
      outcome: "created",
      approval: { id: "approval_1", status: "pending", action_class: "INTERNAL_WRITE" },
    }));
    expect(created).toMatchObject({ ok: true, approval: { status: "pending" } });

    const rpcClient = client({
      outcome: "consumed",
      challengeId: "challenge_1",
      challenge: "opaque-challenge",
    });
    const consumed = await consumeApprovalAuthenticationChallenge({
      userId: "user_1",
      approvalId: "approval_1",
      challengeId: "challenge_1",
      now: "2026-07-16T00:00:00.000Z",
    }, rpcClient);
    expect(consumed).toEqual({
      ok: true,
      challengeId: "challenge_1",
      challenge: "opaque-challenge",
    });
    expect(rpcClient.rpc).toHaveBeenCalledWith(
      "consume_approval_authentication_challenge",
      expect.objectContaining({ p_challenge_id: "challenge_1" }),
    );
  });
});
