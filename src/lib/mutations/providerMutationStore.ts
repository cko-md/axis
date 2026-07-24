import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProviderMutationStore,
  ProviderMutationProvider,
  ProviderMutationState,
  InternalProviderMutation,
  SafeProviderMutationReceipt,
} from "./providerMutationKernel";

type RpcClient = Pick<SupabaseClient, "rpc">;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const mutationStates = new Set<ProviderMutationState>([
  "prepared",
  "dispatching",
  "outcome_unknown",
  "succeeded",
  "failed_before_dispatch",
  "reconciliation_required",
]);
const mutationProviders = new Set<ProviderMutationProvider>(["gmail", "outlook", "googlecalendar"]);
const mutationKinds = new Set<InternalProviderMutation["kind"]>(["mail_send", "mail_reply", "calendar_create", "calendar_delete", "composio_disconnect"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/i;
function timestamp(value: unknown): string | null {
  const parsed = string(value);
  return parsed && parsed.length <= 64 && !Number.isNaN(Date.parse(parsed)) ? parsed : null;
}

function command(value: unknown): InternalProviderMutation | null {
  const row = record(value);
  const id = string(row?.id);
  const userId = string(row?.user_id);
  const idempotencyKey = string(row?.idempotency_key);
  const semanticHash = string(row?.semantic_hash);
  const kind = string(row?.kind);
  const provider = string(row?.provider);
  const connectionRef = string(row?.connection_ref);
  const transport = row?.transport;
  const state = string(row?.state);
  const version = number(row?.version);
  const createdAt = timestamp(row?.created_at);
  const updatedAt = timestamp(row?.updated_at);
  const deletionExpectedCount = number(row?.deletion_expected_count);
  if (
    !id || !userId || !idempotencyKey || !semanticHash || !kind || !provider || !connectionRef || transport !== "composio"
    || !uuid.test(id) || !uuid.test(userId) || !digest.test(idempotencyKey) || !digest.test(semanticHash)
    || !mutationKinds.has(kind as InternalProviderMutation["kind"]) || !mutationProviders.has(provider as ProviderMutationProvider)
    || !state || !mutationStates.has(state as ProviderMutationState) || version === null || !Number.isInteger(version) || version < 0 || !createdAt || !updatedAt
    || (deletionExpectedCount !== null && (!Number.isInteger(deletionExpectedCount) || deletionExpectedCount < 1 || deletionExpectedCount > 2))
  ) return null;
  return {
    id,
    userId,
    idempotencyKey,
    semanticHash,
    kind: kind as InternalProviderMutation["kind"],
    provider: provider as ProviderMutationProvider,
    transport,
    connectionRef,
    state: state as ProviderMutationState,
    version,
    targetResourceId: string(row?.target_resource_id),
    externalResourceId: string(row?.external_resource_id),
    deletionCohortId: string(row?.deletion_cohort_id),
    deletionExpectedCount,
    repairRequired: row?.repair_required === true,
    createdAt,
    updatedAt,
  };
}

function result(value: unknown): { outcome: string; mutation: InternalProviderMutation } | null {
  const body = record(value);
  const outcome = string(body?.outcome);
  const mutation = command(body?.command);
  return outcome && mutation ? { outcome, mutation } : null;
}

async function call(client: RpcClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name as never, args as never);
  if (error) throw new Error("provider mutation persistence failed");
  return data;
}

function receiptArgs(receipt: SafeProviderMutationReceipt | undefined) {
  return {
    p_provider_receipt_id: receipt?.providerReceiptId ?? null,
    p_external_resource_id: receipt?.externalResourceId ?? null,
    p_provider_status: receipt?.providerStatus ?? null,
  };
}

/**
 * The admin client is the only supported caller. Every transition reaches a
 * service-role-only SECURITY DEFINER RPC; this wrapper never exposes a raw
 * command record to browser code.
 */
export function createSupabaseProviderMutationStore(client: RpcClient | null): ProviderMutationStore | null {
  if (!client) return null;
  return {
    async prepare(input) {
      const parsed = result(await call(client, "prepare_provider_mutation_command", {
        p_user_id: input.userId,
        p_idempotency_key: input.idempotencyKey,
        p_semantic_hash: input.semanticHash,
        p_kind: input.kind,
        p_provider: input.provider,
        p_transport: input.transport,
        p_connection_ref: input.connectionRef ?? null,
        p_target_resource_id: input.targetResourceId ?? null,
        p_external_resource_id: input.externalResourceId ?? null,
        p_deletion_cohort_id: input.deletionCohortId ?? null,
      }));
      if (!parsed) throw new Error("invalid provider mutation prepare response");
      if (parsed.outcome === "created") return { kind: "created", mutation: parsed.mutation };
      if (parsed.outcome === "replayed") return { kind: "replayed", mutation: parsed.mutation };
      if (parsed.outcome === "idempotency_conflict") return { kind: "idempotency_conflict", mutation: parsed.mutation };
      throw new Error("invalid provider mutation prepare outcome");
    },

    async claim(input) {
      const parsed = result(await call(client, "claim_provider_mutation_command", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
      }));
      if (!parsed) throw new Error("invalid provider mutation claim response");
      if (parsed.outcome === "claimed") return { kind: "claimed", mutation: parsed.mutation };
      if (parsed.outcome === "not_claimable") return { kind: "not_claimable", mutation: parsed.mutation };
      throw new Error("invalid provider mutation claim outcome");
    },

    async succeed(input) {
      const parsed = result(await call(client, "complete_provider_mutation_command", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        ...receiptArgs(input.receipt),
      }));
      if (!parsed || parsed.outcome !== "succeeded") throw new Error("invalid provider mutation success response");
      return parsed.mutation;
    },

    async failBeforeDispatch(input) {
      const parsed = result(await call(client, "fail_provider_mutation_before_dispatch", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        p_error_code: input.errorCode,
      }));
      if (!parsed || parsed.outcome !== "failed_before_dispatch") throw new Error("invalid provider mutation failure response");
      return parsed.mutation;
    },

    async reopenBeforeDispatch(input) {
      const parsed = result(await call(client, "reopen_provider_mutation_before_dispatch", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
      }));
      if (!parsed || parsed.outcome !== "reopened") throw new Error("invalid provider mutation reopen response");
      return parsed.mutation;
    },

    async reopenBeforeDispatchWithSemanticHash(input) {
      const parsed = result(await call(client, "reopen_provider_mutation_before_dispatch", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        p_semantic_hash: input.semanticHash,
      }));
      if (!parsed || parsed.outcome !== "reopened") throw new Error("invalid provider mutation semantic reopen response");
      return parsed.mutation;
    },

    async markOutcomeUnknown(input) {
      const parsed = result(await call(client, "mark_provider_mutation_outcome_unknown", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        p_error_code: input.errorCode,
      }));
      if (!parsed || parsed.outcome !== "outcome_unknown") throw new Error("invalid provider mutation unknown response");
      return parsed.mutation;
    },

    async markReconciliationRequired(input) {
      const parsed = result(await call(client, "mark_provider_mutation_reconciliation_required", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        p_reason: input.reason,
        ...receiptArgs(input.receipt),
      }));
      if (!parsed || parsed.outcome !== "reconciliation_required") {
        throw new Error("invalid provider mutation repair response");
      }
      return parsed.mutation;
    },

    async reconcile(input) {
      const parsed = result(await call(client, "reconcile_provider_mutation_command", {
        p_command_id: input.mutationId,
        p_expected_version: input.expectedVersion,
        ...receiptArgs(input.receipt),
      }));
      if (!parsed || parsed.outcome !== "succeeded") throw new Error("invalid provider mutation reconciliation response");
      return parsed.mutation;
    },
  };
}
