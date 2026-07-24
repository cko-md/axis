import { NextResponse } from "next/server";
import type { InternalProviderMutation, ProviderMutationExecutionResult } from "./providerMutationKernel";

/** The only command metadata that a browser mutation response may expose. */
function publicCommand(mutation: InternalProviderMutation) {
  return {
    id: mutation.id,
    kind: mutation.kind,
    provider: mutation.provider,
    state: mutation.state,
    repairRequired: mutation.repairRequired,
    createdAt: mutation.createdAt,
    updatedAt: mutation.updatedAt,
  };
}

export function providerMutationResponse(result: ProviderMutationExecutionResult) {
  if (result.kind === "service_unavailable") {
    return NextResponse.json(
      { ok: false, state: "unavailable", error: "This request did not initiate dispatch. Check the action status before trying again." },
      { status: 503 },
    );
  }
  if (result.kind === "idempotency_conflict") {
    return NextResponse.json(
      { ok: false, state: "idempotency_conflict", error: "This idempotency key belongs to a different request.", command: publicCommand(result.mutation) },
      { status: 409 },
    );
  }
  if (result.kind === "succeeded" || (result.kind === "replayed" && result.mutation.state === "succeeded")) {
    return NextResponse.json({ ok: true, state: "succeeded", command: publicCommand(result.mutation) });
  }
  if (result.kind === "failed_before_dispatch" || (result.kind === "replayed" && result.mutation.state === "failed_before_dispatch")) {
    return NextResponse.json(
      { ok: false, state: "failed_before_dispatch", error: "The action was stopped before contacting the provider.", command: publicCommand(result.mutation) },
      { status: 422 },
    );
  }
  const mutation = result.mutation;
  const state = result.kind === "replayed" ? mutation.state : result.kind === "repair_required"
    ? "reconciliation_required"
    : "outcome_unknown";
  return NextResponse.json(
    {
      ok: false,
      state,
      error: "Provider outcome is not yet certain. Do not retry this action; reconcile it first.",
      command: publicCommand(mutation),
    },
    { status: 202 },
  );
}
