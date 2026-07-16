import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createRoutineResumeClaims } from "./resumeClaims";

type RpcResult = { data: unknown; error: unknown };

function mockClient(input: {
  rpc?: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  terminal?: { data: unknown; error: unknown };
}) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => input.terminal ?? { data: null, error: null });
  const rpc = vi.fn(input.rpc ?? (async () => ({ data: null, error: null })));
  const from = vi.fn(() => query);
  return {
    client: { rpc, from } as unknown as SupabaseClient,
    rpc,
    from,
    query,
  };
}

describe("routine resume claims", () => {
  it("retries an ambiguous claim with the same token and parses the persisted idempotency key", async () => {
    let attempt = 0;
    const { client, rpc } = mockClient({
      rpc: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transport reset");
        return {
          error: null,
          data: {
            outcome: "claimed",
            runId: "run-1",
            status: "running",
            routineKey: "concentration_review",
            routineVersion: 3,
            inputSnapshot: { maxWeight: 0.2 },
            stepKey: "create_tasks",
            approvalId: "approval-1",
            idempotencyKey: "persisted-key",
            resumeAttempt: 2,
            claimExpiresAt: "2026-07-16T18:00:00.000Z",
            reused: true,
          },
        };
      },
    });

    const result = await createRoutineResumeClaims(client).claim({
      userId: "user-1",
      runId: "run-1",
      claimToken: "claim-token",
      leaseSeconds: 90,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "claimed",
        runId: "run-1",
        status: "running",
        routineKey: "concentration_review",
        routineVersion: 3,
        inputSnapshot: { maxWeight: 0.2 },
        stepKey: "create_tasks",
        approvalId: "approval-1",
        idempotencyKey: "persisted-key",
        resumeAttempt: 2,
        claimExpiresAt: "2026-07-16T18:00:00.000Z",
        reused: true,
      },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });

  it("reconciles an ambiguous completion by rereading the terminal run", async () => {
    const { client, from } = mockClient({
      rpc: async () => ({ data: null, error: { code: "NETWORK_ERROR" } }),
      terminal: {
        error: null,
        data: {
          id: "run-1",
          status: "completed",
          output: { total: 42 },
          actual_cost_usd: 0,
          completed_at: "2026-07-16T18:01:00.000Z",
          approval_id: "approval-1",
        },
      },
    });

    const result = await createRoutineResumeClaims(client).complete({
      userId: "user-1",
      runId: "run-1",
      claimToken: "claim-token",
      status: "completed",
      output: { total: 42 },
      actualCostUsd: 0,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "completed",
        output: { total: 42 },
        actualCostUsd: 0,
        completedAt: "2026-07-16T18:01:00.000Z",
        approvalId: "approval-1",
        reused: true,
      },
    });
    expect(from).toHaveBeenCalledWith("routine_runs");
  });

  it("also reconciles an invalid completion response by rereading terminal state", async () => {
    const { client } = mockClient({
      rpc: async () => ({ data: null, error: null }),
      terminal: {
        error: null,
        data: {
          id: "run-1",
          status: "partial",
          output: { total: 40 },
          actual_cost_usd: 0.01,
          completed_at: "2026-07-16T18:01:30.000Z",
          approval_id: "approval-1",
        },
      },
    });

    await expect(createRoutineResumeClaims(client).complete({
      userId: "user-1",
      runId: "run-1",
      claimToken: "claim-token",
      status: "partial",
      output: { total: 40 },
      actualCostUsd: 0.01,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        status: "partial",
        output: { total: 40 },
        reused: true,
      },
    });
  });

  it("surfaces a failed terminal reread instead of guessing that completion committed", async () => {
    const { client } = mockClient({
      rpc: async () => ({ data: null, error: { code: "NETWORK_ERROR" } }),
      terminal: { data: null, error: { code: "DB_DOWN" } },
    });

    await expect(createRoutineResumeClaims(client).complete({
      userId: "user-1",
      runId: "run-1",
      claimToken: "claim-token",
      status: "completed",
      output: {},
      actualCostUsd: 0,
    })).resolves.toEqual({ ok: false, code: "RECONCILIATION_FAILED" });
  });

  it("maps stale-token fencing outcomes without exposing raw RPC errors", async () => {
    const { client } = mockClient({
      rpc: async () => ({
        error: null,
        data: { outcome: "claim_lost", currentStatus: "running" },
      }),
    });

    await expect(createRoutineResumeClaims(client).renew({
      userId: "user-1",
      runId: "run-1",
      claimToken: "stale-token",
    })).resolves.toEqual({
      ok: false,
      code: "CLAIM_LOST",
      currentStatus: "running",
    });
  });

  it("returns persisted terminal state for an idempotent retry", async () => {
    const { client } = mockClient({
      rpc: async () => ({
        error: null,
        data: {
          outcome: "terminal",
          runId: "run-1",
          status: "completed",
          output: { total: 7 },
          actualCostUsd: 0,
          completedAt: "2026-07-16T18:02:00.000Z",
        },
      }),
    });

    await expect(createRoutineResumeClaims(client).claim({
      userId: "user-1",
      runId: "run-1",
      claimToken: "new-token",
    })).resolves.toEqual({
      ok: true,
      value: {
        kind: "terminal",
        runId: "run-1",
        status: "completed",
        output: { total: 7 },
        actualCostUsd: 0,
        completedAt: "2026-07-16T18:02:00.000Z",
      },
    });
  });
});
