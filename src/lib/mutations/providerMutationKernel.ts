/**
 * Durable, single-attempt provider-mutation protocol.
 *
 * This module deliberately stores and returns only safe metadata.  Callers
 * retain private request payloads in memory long enough to make one provider
 * attempt; they must never persist raw message bodies or provider responses in
 * a command or receipt.  A transport error after claim is *ambiguous* by
 * definition and is therefore never retried here.
 */

export const PROVIDER_MUTATION_STATES = [
  "prepared",
  "dispatching",
  "outcome_unknown",
  "succeeded",
  "failed_before_dispatch",
  "reconciliation_required",
] as const;

export type ProviderMutationState = (typeof PROVIDER_MUTATION_STATES)[number];
export type ProviderMutationSafeErrorCode =
  | "timeout"
  | "abort"
  | "network"
  | "unknown"
  | "local_preflight_failed"
  | "configuration_unavailable"
  | "account_unavailable"
  | "invalid_operation"
  | "receipt_persist_failed"
  | "missing_external_id"
  | "transition_conflict"
  | "post_ack_reconciliation_required"
  | "confirmed";
export type ProviderMutationKind =
  | "mail_send"
  | "mail_reply"
  | "calendar_create"
  | "calendar_delete"
  | "composio_disconnect";
export type ProviderMutationProvider = "gmail" | "outlook" | "googlecalendar";

/** Trusted server-memory record. Never serialize this to a browser. */
export type InternalProviderMutation = {
  id: string;
  userId: string;
  idempotencyKey: string;
  semanticHash: string;
  kind: ProviderMutationKind;
  provider: ProviderMutationProvider;
  transport: "composio";
  /** Server-internal verified connected-account reference; never browser-projected. */
  connectionRef: string;
  state: ProviderMutationState;
  version: number;
  targetResourceId?: string | null;
  externalResourceId?: string | null;
  deletionCohortId?: string | null;
  deletionExpectedCount?: number | null;
  repairRequired: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Metadata only. Never put a provider response body or request payload here. */
export type SafeProviderMutationReceipt = {
  providerReceiptId?: string | null;
  externalResourceId?: string | null;
  providerStatus?: number | null;
};

/**
 * Reaching this return value means the provider positively acknowledged the
 * mutation. Any thrown error or non-acknowledging adapter result is ambiguous
 * and must be thrown by the dispatch adapter so the kernel records unknown.
 */
export type ProviderDispatchAcknowledgement = {
  acknowledged: true;
  receipt: SafeProviderMutationReceipt;
};

export type ProviderMutationPrepareInput = Omit<
  InternalProviderMutation,
  "id" | "state" | "version" | "repairRequired" | "createdAt" | "updatedAt" | "deletionExpectedCount"
>;

export type ProviderMutationStore = {
  prepare(input: ProviderMutationPrepareInput): Promise<
    | { kind: "created"; mutation: InternalProviderMutation }
    | { kind: "replayed"; mutation: InternalProviderMutation }
    | { kind: "idempotency_conflict"; mutation: InternalProviderMutation }
  >;
  claim(input: { mutationId: string; expectedVersion: number }): Promise<
    | { kind: "claimed"; mutation: InternalProviderMutation }
    | { kind: "not_claimable"; mutation: InternalProviderMutation }
  >;
  succeed(input: {
    mutationId: string;
    expectedVersion: number;
    receipt: SafeProviderMutationReceipt;
  }): Promise<InternalProviderMutation>;
  failBeforeDispatch(input: {
    mutationId: string;
    expectedVersion: number;
    errorCode: ProviderMutationSafeErrorCode;
  }): Promise<InternalProviderMutation>;
  /** Safe only when no dispatch claim was ever recorded. */
  reopenBeforeDispatch(input: { mutationId: string; expectedVersion: number }): Promise<InternalProviderMutation>;
  reopenBeforeDispatchWithSemanticHash(input: { mutationId: string; expectedVersion: number; semanticHash: string }): Promise<InternalProviderMutation>;
  markOutcomeUnknown(input: {
    mutationId: string;
    expectedVersion: number;
    errorCode: "timeout" | "abort" | "network" | "unknown";
  }): Promise<InternalProviderMutation>;
  markReconciliationRequired(input: {
    mutationId: string;
    expectedVersion: number;
    reason: "receipt_persist_failed" | "missing_external_id" | "transition_conflict" | "post_ack_reconciliation_required";
    receipt?: SafeProviderMutationReceipt;
  }): Promise<InternalProviderMutation>;
  reconcile(input: {
    mutationId: string;
    expectedVersion: number;
    receipt?: SafeProviderMutationReceipt;
  }): Promise<InternalProviderMutation>;
};

export type ProviderMutationExecutionInput = ProviderMutationPrepareInput & {
  /**
   * Local-only, non-provider validation. A false result is the sole path to
   * failed_before_dispatch; it runs before a dispatch claim exists.
   */
  preflight?: () => Promise<
    { permitted: true }
    | { permitted: false; errorCode: "local_preflight_failed" | "configuration_unavailable" | "account_unavailable" | "invalid_operation" }
  >;
  /** One provider attempt only. Throwing after claim is treated as ambiguous. */
  dispatch(signal: AbortSignal): Promise<ProviderDispatchAcknowledgement>;
  deadlineMs?: number;
  /** Some mutations cannot prove success without a provider-resource id. */
  requireExternalResourceId?: boolean;
  /** Provider acknowledgement alone is insufficient; retain a repairable tombstone. */
  requireReconciliationAfterAck?: boolean;
};

export type ProviderMutationExecutionResult =
  | { kind: "succeeded"; mutation: InternalProviderMutation }
  | { kind: "replayed"; mutation: InternalProviderMutation }
  | { kind: "idempotency_conflict"; mutation: InternalProviderMutation }
  | { kind: "failed_before_dispatch"; mutation: InternalProviderMutation }
  | { kind: "outcome_unknown"; mutation: InternalProviderMutation }
  | { kind: "repair_required"; mutation: InternalProviderMutation }
  | { kind: "service_unavailable" };

export type ProviderMutationReconciliationResult =
  | { kind: "succeeded"; mutation: InternalProviderMutation }
  | { kind: "repair_required"; mutation: InternalProviderMutation }
  | { kind: "service_unavailable" };

export type ProviderReconciliationProof =
  | { kind: "calendar_create_found"; externalResourceId: string; providerReceiptId?: string; providerStatus?: number }
  | { kind: "calendar_delete_absent"; providerStatus: 404 | 410; providerReceiptId?: string }
  | { kind: "composio_disconnect_absent"; providerStatus: 404 | 410; providerReceiptId?: string };

function ambiguousErrorCode(error: unknown): "timeout" | "abort" | "network" | "unknown" {
  const name = error instanceof Error ? error.name : "";
  if (name === "ProviderTimeoutError" || name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "abort";
  if (name === "TypeError") return "network";
  return "unknown";
}

function validReceipt(value: unknown): value is SafeProviderMutationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["providerReceiptId", "externalResourceId", "providerStatus"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  for (const key of ["providerReceiptId", "externalResourceId"] as const) {
    if (record[key] !== undefined && record[key] !== null && (typeof record[key] !== "string" || record[key].length > 256)) return false;
  }
  return record.providerStatus === undefined || record.providerStatus === null
    || (typeof record.providerStatus === "number" && Number.isInteger(record.providerStatus) && record.providerStatus >= 100 && record.providerStatus <= 599);
}

function validAcknowledgement(value: unknown): value is ProviderDispatchAcknowledgement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.acknowledged === true && validReceipt(record.receipt);
}

async function repairRequired(
  store: ProviderMutationStore,
  input: {
    mutation: InternalProviderMutation;
    reason: "receipt_persist_failed" | "missing_external_id" | "transition_conflict" | "post_ack_reconciliation_required";
    receipt?: SafeProviderMutationReceipt;
  },
): Promise<ProviderMutationExecutionResult> {
  try {
    const mutation = await store.markReconciliationRequired({
      mutationId: input.mutation.id,
      expectedVersion: input.mutation.version,
      reason: input.reason,
      receipt: input.receipt,
    });
    return { kind: "repair_required", mutation };
  } catch {
    // The provider may already have executed. Do not invent a state that
    // failed to persist: callers receive the last durable command unchanged.
    return { kind: "repair_required", mutation: input.mutation };
  }
}

async function reconciliationRepairRequired(
  store: ProviderMutationStore,
  input: {
    mutation: InternalProviderMutation;
    reason: "receipt_persist_failed" | "missing_external_id" | "transition_conflict" | "post_ack_reconciliation_required";
    receipt?: SafeProviderMutationReceipt;
  },
): Promise<ProviderMutationReconciliationResult> {
  try {
    const mutation = await store.markReconciliationRequired({
      mutationId: input.mutation.id,
      expectedVersion: input.mutation.version,
      reason: input.reason,
      receipt: input.receipt,
    });
    return { kind: "repair_required", mutation };
  } catch {
    return { kind: "repair_required", mutation: input.mutation };
  }
}

export function createProviderMutationKernel({ store }: { store: ProviderMutationStore | null }) {
  return {
    async execute(input: ProviderMutationExecutionInput): Promise<ProviderMutationExecutionResult> {
      if (!store) return { kind: "service_unavailable" };

      let prepared: Awaited<ReturnType<ProviderMutationStore["prepare"]>>;
      try {
        prepared = await store.prepare({
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          semanticHash: input.semanticHash,
          kind: input.kind,
          provider: input.provider,
          transport: input.transport,
          connectionRef: input.connectionRef,
          targetResourceId: input.targetResourceId,
          externalResourceId: input.externalResourceId,
          deletionCohortId: input.deletionCohortId,
        });
      } catch {
        // No durable intent means there is categorically no provider call.
        return { kind: "service_unavailable" };
      }
      if (prepared.kind === "idempotency_conflict") {
        // Calendar creation has a stable identity independent of the HMAC
        // digest. A changed digest (including key rotation) may be accepted
        // only when the original command proves it never reached dispatch.
        if (prepared.mutation.kind !== "calendar_create" || prepared.mutation.state !== "failed_before_dispatch" || !input.preflight) return prepared;
        let eligibility: Awaited<ReturnType<NonNullable<ProviderMutationExecutionInput["preflight"]>>>;
        try { eligibility = await input.preflight(); } catch { return prepared; }
        if (!eligibility.permitted) return prepared;
        try {
          const mutation = await store.reopenBeforeDispatchWithSemanticHash({
            mutationId: prepared.mutation.id, expectedVersion: prepared.mutation.version, semanticHash: input.semanticHash,
          });
          prepared = { kind: "created", mutation };
        } catch { return { kind: "service_unavailable" }; }
      }
      // A persisted `prepared` command has never been dispatched. It may have
      // survived a crash between durable intent and CAS claim, so continuing it
      // is safe. Every other same-key replay returns its durable state intact.
      if (prepared.kind === "replayed" && prepared.mutation.state !== "prepared") {
        if (prepared.mutation.state !== "failed_before_dispatch" || !input.preflight) return prepared;
        let eligibility: Awaited<ReturnType<NonNullable<ProviderMutationExecutionInput["preflight"]>>>;
        try { eligibility = await input.preflight(); } catch { return prepared; }
        if (!eligibility.permitted) return prepared;
        try {
          const mutation = await store.reopenBeforeDispatch({
            mutationId: prepared.mutation.id,
            expectedVersion: prepared.mutation.version,
          });
          prepared = { kind: "created", mutation };
        } catch {
          return { kind: "service_unavailable" };
        }
      }

      if (input.preflight) {
        let preflight: Awaited<ReturnType<NonNullable<ProviderMutationExecutionInput["preflight"]>>>;
        try {
          preflight = await input.preflight();
        } catch {
          preflight = { permitted: false, errorCode: "local_preflight_failed" };
        }
        if (!preflight.permitted) {
          try {
            const mutation = await store.failBeforeDispatch({
              mutationId: prepared.mutation.id,
              expectedVersion: prepared.mutation.version,
              errorCode: preflight.errorCode,
            });
            return { kind: "failed_before_dispatch", mutation };
          } catch {
            return { kind: "service_unavailable" };
          }
        }
      }

      let claimed: Awaited<ReturnType<ProviderMutationStore["claim"]>>;
      try {
        claimed = await store.claim({ mutationId: prepared.mutation.id, expectedVersion: prepared.mutation.version });
      } catch {
        return { kind: "service_unavailable" };
      }
      if (claimed.kind === "not_claimable") return { kind: "replayed", mutation: claimed.mutation };

      let acknowledgement: ProviderDispatchAcknowledgement;
      const controller = new AbortController();
      const deadlineMs = Math.min(Math.max(input.deadlineMs ?? 12_000, 100), 30_000);
      let rejectDeadline!: (reason: Error) => void;
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const timeout = setTimeout(() => {
        controller.abort();
        const error = new Error("Provider mutation deadline exceeded");
        error.name = "TimeoutError";
        rejectDeadline(error);
      }, deadlineMs);
      try {
        // The race is intentional: an adapter that ignores AbortSignal cannot
        // hold this request forever. Any late side effect remains ambiguous.
        const result: unknown = await Promise.race([input.dispatch(controller.signal), deadline]);
        if (!validAcknowledgement(result)) throw new TypeError("Provider adapter returned an invalid acknowledgement");
        acknowledgement = result;
      } catch (error) {
        try {
          const mutation = await store.markOutcomeUnknown({
            mutationId: claimed.mutation.id,
            expectedVersion: claimed.mutation.version,
            errorCode: ambiguousErrorCode(error),
          });
          return { kind: "outcome_unknown", mutation };
        } catch {
          return repairRequired(store, { mutation: claimed.mutation, reason: "transition_conflict" });
        }
      } finally {
        clearTimeout(timeout);
      }

      if (input.requireExternalResourceId && !acknowledgement.receipt.externalResourceId) {
        return reconciliationRepairRequired(store, {
          mutation: claimed.mutation,
          reason: "missing_external_id",
          receipt: acknowledgement.receipt,
        });
      }

      if (input.requireReconciliationAfterAck) {
        return repairRequired(store, {
          mutation: claimed.mutation,
          reason: "post_ack_reconciliation_required",
          receipt: acknowledgement.receipt,
        });
      }

      try {
        const mutation = await store.succeed({
          mutationId: claimed.mutation.id,
          expectedVersion: claimed.mutation.version,
          receipt: acknowledgement.receipt,
        });
        return { kind: "succeeded", mutation };
      } catch {
        // Provider acknowledgement happened but its append-only receipt did
        // not durably commit.  This is repair work, never a resend invitation.
        return repairRequired(store, {
          mutation: claimed.mutation,
          reason: "receipt_persist_failed",
          receipt: acknowledgement.receipt,
        });
      }
    },

    /** Only call after a provider-specific read has positively proved execution. */
    async reconcile(input: {
      mutation: InternalProviderMutation;
      proof: ProviderReconciliationProof;
    }): Promise<ProviderMutationReconciliationResult> {
      if (!store) return { kind: "service_unavailable" };
      const proofMatches = (input.mutation.kind === "calendar_create" && input.proof.kind === "calendar_create_found")
        || (input.mutation.kind === "calendar_delete" && input.proof.kind === "calendar_delete_absent");
      const disconnectProofMatches = input.mutation.kind === "composio_disconnect" && input.proof.kind === "composio_disconnect_absent";
      if (!(proofMatches || disconnectProofMatches) || !validReceipt({
        providerReceiptId: input.proof.providerReceiptId,
        externalResourceId: input.proof.kind === "calendar_create_found" ? input.proof.externalResourceId : undefined,
        providerStatus: input.proof.providerStatus,
      })) {
        return { kind: "repair_required", mutation: input.mutation };
      }
      const receipt: SafeProviderMutationReceipt = {
        providerReceiptId: input.proof.providerReceiptId,
        externalResourceId: input.proof.kind === "calendar_create_found" ? input.proof.externalResourceId : undefined,
        providerStatus: input.proof.providerStatus,
      };
      try {
        const mutation = await store.reconcile({
          mutationId: input.mutation.id,
          expectedVersion: input.mutation.version,
          receipt,
        });
        return { kind: "succeeded", mutation };
      } catch {
        return reconciliationRepairRequired(store, {
          mutation: input.mutation,
          reason: "transition_conflict",
          receipt,
        });
      }
    },
  };
}
