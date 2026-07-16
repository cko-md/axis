import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import {
  BUILTIN_ROUTINE_VERSIONS,
  REBALANCE_PROPOSAL_CURRENT_VERSION,
  cloneRoutineVersion,
  compareRoutineVersions,
  definitionFromJson,
  definitionToJson,
  nextRoutineVersion,
} from "./versioning";

function builtin(id: string) {
  const routine = BUILTIN_ROUTINE_VERSIONS.find((candidate) => candidate.id === id);
  if (!routine) throw new Error(`Missing builtin routine version: ${id}`);
  return routine;
}

describe("routine versioning", () => {
  it("compares routine definitions by steps, inputs, and safety contract", () => {
    const left = BUILTIN_ROUTINE_VERSIONS[0];
    const right = {
      ...left,
      id: "user-version",
      definition: {
        ...left.definition,
        inputs: { ...left.definition.inputs, minValue: { type: "number", default: 100 } },
        steps: [...left.definition.steps, "notify_user"],
        safety: [...left.definition.safety, "notifies_user"],
      },
    };

    const diff = compareRoutineVersions(left, right);

    expect(diff.sameRoutine).toBe(true);
    expect(diff.changed).toEqual(["steps", "inputs", "safety"]);
    expect(diff.stepChanges.added).toEqual(["notify_user"]);
    expect(diff.inputChanges.added).toEqual(["minValue"]);
    expect(diff.safetyChanges.added).toEqual(["notifies_user"]);
  });

  it("compares per-routine integration requirements by key and contract", () => {
    const left = builtin(`builtin:rebalance_proposal:${REBALANCE_PROPOSAL_CURRENT_VERSION}`);
    const right = {
      ...left,
      id: "user-version",
      definition: {
        ...left.definition,
        integrationRequirements: [
          ...(left.definition.integrationRequirements ?? []).filter((item) => item.key !== "polygon.market_prices"),
          {
            key: "plaid.bank_transactions",
            label: "Plaid bank transactions",
            provider: "plaid",
            domain: "banking" as const,
            required: false,
            purpose: "Read bank transaction context for cash-aware rebalancing.",
            capabilities: ["read:transactions"],
            actionClass: "READ" as const,
            touchesSensitiveData: true,
          },
          {
            ...(left.definition.integrationRequirements ?? [])[0],
            purpose: "Changed purpose.",
          },
        ],
      },
    };

    const diff = compareRoutineVersions(left, right);

    expect(diff.changed).toContain("integrationRequirements");
    expect(diff.integrationChanges.added).toEqual(["plaid.bank_transactions"]);
    expect(diff.integrationChanges.removed).toEqual(["polygon.market_prices"]);
    expect(diff.integrationChanges.changed).toEqual(["supabase.fund_holdings_and_runs"]);
  });

  it("allocates the next version per routine key", () => {
    expect(nextRoutineVersion(BUILTIN_ROUTINE_VERSIONS, "concentration_review")).toBe(2);
    expect(nextRoutineVersion(BUILTIN_ROUTINE_VERSIONS, "rebalance_proposal")).toBe(3);
    expect(nextRoutineVersion(BUILTIN_ROUTINE_VERSIONS, "new_routine")).toBe(1);
  });

  it("clones a version without changing the source definition in place", () => {
    const source = BUILTIN_ROUTINE_VERSIONS[0];
    const cloned = cloneRoutineVersion(source, 4, "draft");

    expect(cloned.routineKey).toBe(source.routineKey);
    expect(cloned.routineVersion).toBe(4);
    expect(cloned.definition.version).toBe(4);
    expect(source.definition.version).toBe(1);
    expect(cloned.sourceVersionId).toBe(source.id);
  });

  it("round-trips a definition through JSON with validation", () => {
    const definition = builtin(`builtin:rebalance_proposal:${REBALANCE_PROPOSAL_CURRENT_VERSION}`).definition;
    expect(definitionFromJson(definitionToJson(definition))).toEqual(definition);
    expect(definitionFromJson({ ...definition, integrationRequirements: [{ key: "bad" }] } as unknown as Json)).toBeNull();
    expect(definitionFromJson({ routineKey: "bad" })).toBeNull();
  });

  it("preserves historical rebalance v1 and makes v2 the simulation-only contract", () => {
    const historical = builtin("builtin:rebalance_proposal:1");
    const current = builtin(`builtin:rebalance_proposal:${REBALANCE_PROPOSAL_CURRENT_VERSION}`);
    const requirements = current.definition.integrationRequirements ?? [];

    expect(historical.definition.steps).toContain("create_approvals");
    expect(historical.definition.integrationRequirements?.some(
      (requirement) => requirement.domain === "brokerage",
    )).toBe(true);
    expect(current.routineVersion).toBe(2);
    expect(current.definition.version).toBe(2);
    expect(requirements.map((requirement) => requirement.key)).toEqual([
      "supabase.fund_holdings_and_runs",
      "polygon.market_prices",
      "openai.proposal_explanation",
    ]);
    expect(requirements.some((requirement) => requirement.domain === "brokerage")).toBe(false);
    expect(current.definition.safety).toEqual(expect.arrayContaining([
      "simulation_only",
      "broker_submission_disabled",
    ]));
  });
});
