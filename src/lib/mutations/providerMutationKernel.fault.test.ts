import { describe, expect, it, vi } from "vitest";
import {
  createProviderMutationKernel,
  type InternalProviderMutation,
  type ProviderMutationStore,
} from "./providerMutationKernel";

const base = (overrides: Partial<InternalProviderMutation> = {}): InternalProviderMutation => ({
  id: "command-1", userId: "owner-a", idempotencyKey: "a".repeat(64), semanticHash: "b".repeat(64),
  kind: "mail_send", provider: "gmail", transport: "composio", connectionRef: "connected-account-a",
  state: "prepared", version: 0, repairRequired: false, createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T00:00:00.000Z", ...overrides,
});

function store(overrides: Partial<ProviderMutationStore> = {}) {
  const mutation = base();
  return {
    prepare: vi.fn().mockResolvedValue({ kind: "created", mutation }),
    claim: vi.fn().mockResolvedValue({ kind: "claimed", mutation: base({ state: "dispatching", version: 1 }) }),
    succeed: vi.fn().mockResolvedValue(base({ state: "succeeded", version: 2 })),
    failBeforeDispatch: vi.fn().mockResolvedValue(base({ state: "failed_before_dispatch", version: 1 })),
    reopenBeforeDispatch: vi.fn().mockResolvedValue(base({ state: "prepared", version: 2 })),
    reopenBeforeDispatchWithSemanticHash: vi.fn().mockResolvedValue(base({ state: "prepared", version: 2 })),
    markOutcomeUnknown: vi.fn().mockResolvedValue(base({ state: "outcome_unknown", version: 2, repairRequired: true })),
    markReconciliationRequired: vi.fn().mockResolvedValue(base({ state: "reconciliation_required", version: 2, repairRequired: true })),
    reconcile: vi.fn().mockResolvedValue(base({ state: "succeeded", version: 3 })),
    ...overrides,
  } as unknown as ProviderMutationStore;
}

const input = () => ({
  userId: "owner-a", idempotencyKey: "a".repeat(64), semanticHash: "b".repeat(64), kind: "mail_send" as const,
  provider: "gmail" as const, transport: "composio" as const, connectionRef: "connected-account-a",
  dispatch: vi.fn().mockResolvedValue({ acknowledged: true as const, receipt: { providerReceiptId: "safe-id" } }),
});

describe("provider mutation kernel adversarial faults", () => {
  it("never dispatches before durable authorization/ownership preparation", async () => {
    const s = store({ prepare: vi.fn().mockRejectedValue(new Error("ownership denied")) });
    const request = input();
    await expect(createProviderMutationKernel({ store: s }).execute(request)).resolves.toEqual({ kind: "service_unavailable" });
    expect(request.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch stale claims, same-key replays, or semantic idempotency collisions", async () => {
    for (const prepared of [
      { kind: "replayed" as const, mutation: base({ state: "succeeded", version: 2 }) },
      { kind: "idempotency_conflict" as const, mutation: base({ semanticHash: "c".repeat(64) }) },
    ]) {
      const s = store({ prepare: vi.fn().mockResolvedValue(prepared) });
      const request = input();
      const result = await createProviderMutationKernel({ store: s }).execute(request);
      expect(result.kind).toBe(prepared.kind);
      expect(request.dispatch).not.toHaveBeenCalled();
    }
    const s = store({ claim: vi.fn().mockResolvedValue({ kind: "not_claimable", mutation: base({ state: "dispatching", version: 1 }) }) });
    const request = input();
    await createProviderMutationKernel({ store: s }).execute(request);
    expect(request.dispatch).not.toHaveBeenCalled();
  });

  it("records local preflight denial without claiming or dispatching", async () => {
    const s = store(); const request = input();
    const result = await createProviderMutationKernel({ store: s }).execute({ ...request, preflight: async () => ({ permitted: false as const, errorCode: "account_unavailable" as const }) });
    expect(result.kind).toBe("failed_before_dispatch");
    expect(s.claim).not.toHaveBeenCalled(); expect(request.dispatch).not.toHaveBeenCalled();
    expect(s.failBeforeDispatch).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "account_unavailable" }));
  });

  it("only reopens a terminal pre-dispatch command after a fresh safe preflight", async () => {
    const s = store({ prepare: vi.fn().mockResolvedValue({ kind: "replayed", mutation: base({ state: "failed_before_dispatch", version: 1 }) }) });
    const request = input();
    const result = await createProviderMutationKernel({ store: s }).execute({ ...request, preflight: async () => ({ permitted: true as const }) });
    expect(result.kind).toBe("succeeded");
    expect(s.reopenBeforeDispatch).toHaveBeenCalled();
    expect(request.dispatch).toHaveBeenCalled();
  });

  it("permits semantic replacement only for never-dispatched calendar creates", async () => {
    const s = store({ prepare: vi.fn().mockResolvedValue({ kind: "idempotency_conflict", mutation: base({ kind: "calendar_create", provider: "googlecalendar", state: "failed_before_dispatch", version: 1 }) }) });
    const request = { ...input(), kind: "calendar_create" as const, provider: "googlecalendar" as const };
    const result = await createProviderMutationKernel({ store: s }).execute({ ...request, preflight: async () => ({ permitted: true as const }) });
    expect(result.kind).toBe("succeeded");
    expect(s.reopenBeforeDispatchWithSemanticHash).toHaveBeenCalled();
    const ambiguous = store({ prepare: vi.fn().mockResolvedValue({ kind: "idempotency_conflict", mutation: base({ kind: "calendar_create", provider: "googlecalendar", state: "outcome_unknown", version: 2 }) }) });
    await createProviderMutationKernel({ store: ambiguous }).execute({ ...request, preflight: async () => ({ permitted: true as const }) });
    expect(ambiguous.reopenBeforeDispatchWithSemanticHash).not.toHaveBeenCalled();
  });

  it("treats deadline, abort, and network failures after claim as ambiguous—not retriable", async () => {
    for (const error of [Object.assign(new Error("timeout"), { name: "TimeoutError" }), Object.assign(new Error("abort"), { name: "AbortError" }), new TypeError("network")]) {
      const s = store(); const request = input(); request.dispatch.mockRejectedValueOnce(error);
      const result = await createProviderMutationKernel({ store: s }).execute(request);
      expect(result.kind).toBe("outcome_unknown"); expect(s.succeed).not.toHaveBeenCalled();
    }
  });

  it("requires repair for acknowledgement persistence/identity gaps and never forwards raw provider data", async () => {
    const s = store({ succeed: vi.fn().mockRejectedValue(new Error("receipt write failed")) });
    const result = await createProviderMutationKernel({ store: s }).execute(input());
    expect(result.kind).toBe("repair_required");
    expect(s.markReconciliationRequired).toHaveBeenCalledWith(expect.objectContaining({ reason: "receipt_persist_failed" }));
    const missing = store();
    const request = input(); request.dispatch.mockResolvedValueOnce({ acknowledged: true, receipt: {} });
    await createProviderMutationKernel({ store: missing }).execute({ ...request, requireExternalResourceId: true });
    expect(missing.markReconciliationRequired).toHaveBeenCalledWith(expect.objectContaining({ reason: "missing_external_id" }));
  });

  it("rejects malformed acknowledgement shapes after claim as an ambiguous outcome", async () => {
    const s = store();
    const request = input();
    request.dispatch.mockResolvedValueOnce({ acknowledged: true, receipt: { rawBody: "must-not-persist" } });
    const result = await createProviderMutationKernel({ store: s }).execute(request);
    expect(result.kind).toBe("outcome_unknown");
    expect(s.succeed).not.toHaveBeenCalled();
  });
});
