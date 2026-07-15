import type { Json } from "@/lib/supabase/database.types";

export type RoutineVersionStatus = "builtin" | "draft" | "active" | "archived";

export type RoutineDefinition = {
  routineKey: string;
  version: number;
  title: string;
  description: string;
  inputs: Record<string, unknown>;
  steps: string[];
  safety: string[];
};

export type RoutineVersion = {
  id: string;
  owner: "builtin" | "user";
  routineKey: string;
  routineVersion: number;
  name: string;
  description: string;
  status: RoutineVersionStatus;
  definition: RoutineDefinition;
  createdAt?: string;
  updatedAt?: string;
  sourceVersionId?: string | null;
};

export type RoutineVersionDiff = {
  sameRoutine: boolean;
  from: string;
  to: string;
  changed: string[];
  stepChanges: {
    added: string[];
    removed: string[];
    unchanged: string[];
  };
  inputChanges: {
    added: string[];
    removed: string[];
    changed: string[];
  };
  safetyChanges: {
    added: string[];
    removed: string[];
  };
};

export const BUILTIN_ROUTINE_VERSIONS: readonly RoutineVersion[] = [
  {
    id: "builtin:concentration_review:1",
    owner: "builtin",
    routineKey: "concentration_review",
    routineVersion: 1,
    name: "Concentration Review",
    description: "Reviews holdings against a maximum position weight and opens tasks for breaches.",
    status: "builtin",
    definition: {
      routineKey: "concentration_review",
      version: 1,
      title: "Concentration Review",
      description: "Deterministic review of holdings concentration.",
      inputs: { maxWeight: { type: "number", default: 0.25 } },
      steps: ["load_holdings", "review_concentration", "create_tasks"],
      safety: ["deterministic_math", "no_financial_execution", "creates_agent_tasks"],
    },
  },
  {
    id: "builtin:rebalance_proposal:1",
    owner: "builtin",
    routineKey: "rebalance_proposal",
    routineVersion: 1,
    name: "Rebalance Proposal",
    description: "Builds proposed order tickets and approval requests from target allocations.",
    status: "builtin",
    definition: {
      routineKey: "rebalance_proposal",
      version: 1,
      title: "Rebalance Proposal",
      description: "Deterministic rebalance proposal; pauses for approval before any execution gate.",
      inputs: {
        targets: { type: "record", required: true },
        driftThreshold: { type: "number", default: 0.05 },
        minTradeValue: { type: "number", default: 1 },
      },
      steps: ["load_holdings", "load_prices", "propose_rebalance", "create_approvals", "explain_proposal"],
      safety: ["deterministic_money", "live_price_provenance", "financial_execution_requires_approval_step_up"],
    },
  },
];

export function getBuiltinRoutineVersion(id: string): RoutineVersion | null {
  return BUILTIN_ROUTINE_VERSIONS.find((routine) => routine.id === id) ?? null;
}

export function compareRoutineVersions(left: RoutineVersion, right: RoutineVersion): RoutineVersionDiff {
  const leftInputs = Object.keys(left.definition.inputs).sort();
  const rightInputs = Object.keys(right.definition.inputs).sort();
  const leftSafety = [...left.definition.safety].sort();
  const rightSafety = [...right.definition.safety].sort();

  const inputChanged = leftInputs.filter((key) => {
    if (!rightInputs.includes(key)) return false;
    return stableStringify(left.definition.inputs[key]) !== stableStringify(right.definition.inputs[key]);
  });

  const changed = [
    left.name !== right.name ? "name" : null,
    left.description !== right.description ? "description" : null,
    left.definition.description !== right.definition.description ? "definition.description" : null,
    hasArrayDelta(left.definition.steps, right.definition.steps) ? "steps" : null,
    hasArrayDelta(leftInputs, rightInputs) || inputChanged.length > 0 ? "inputs" : null,
    hasArrayDelta(leftSafety, rightSafety) ? "safety" : null,
  ].filter((value): value is string => !!value);

  return {
    sameRoutine: left.routineKey === right.routineKey,
    from: left.id,
    to: right.id,
    changed,
    stepChanges: diffArray(left.definition.steps, right.definition.steps),
    inputChanges: {
      added: rightInputs.filter((key) => !leftInputs.includes(key)),
      removed: leftInputs.filter((key) => !rightInputs.includes(key)),
      changed: inputChanged,
    },
    safetyChanges: {
      added: rightSafety.filter((key) => !leftSafety.includes(key)),
      removed: leftSafety.filter((key) => !rightSafety.includes(key)),
    },
  };
}

export function nextRoutineVersion(existing: readonly RoutineVersion[], routineKey: string): number {
  const max = existing
    .filter((routine) => routine.routineKey === routineKey)
    .reduce((highest, routine) => Math.max(highest, routine.routineVersion), 0);
  return max + 1;
}

export function cloneRoutineVersion(source: RoutineVersion, version: number, status: "draft" | "active"): Omit<RoutineVersion, "id" | "owner" | "createdAt" | "updatedAt"> {
  return {
    routineKey: source.routineKey,
    routineVersion: version,
    name: `${source.name} v${version}`,
    description: source.description,
    status,
    definition: {
      ...source.definition,
      version,
    },
    sourceVersionId: source.id,
  };
}

export function definitionToJson(definition: RoutineDefinition): Json {
  return definition as unknown as Json;
}

export function definitionFromJson(value: Json): RoutineDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.routineKey !== "string") return null;
  if (typeof record.version !== "number") return null;
  if (typeof record.title !== "string") return null;
  if (typeof record.description !== "string") return null;
  if (!record.inputs || typeof record.inputs !== "object" || Array.isArray(record.inputs)) return null;
  if (!Array.isArray(record.steps) || !record.steps.every((step) => typeof step === "string")) return null;
  if (!Array.isArray(record.safety) || !record.safety.every((item) => typeof item === "string")) return null;
  return {
    routineKey: record.routineKey,
    version: record.version,
    title: record.title,
    description: record.description,
    inputs: record.inputs as Record<string, unknown>,
    steps: record.steps,
    safety: record.safety,
  };
}

function diffArray(left: readonly string[], right: readonly string[]) {
  return {
    added: right.filter((item) => !left.includes(item)),
    removed: left.filter((item) => !right.includes(item)),
    unchanged: right.filter((item) => left.includes(item)),
  };
}

function hasArrayDelta(left: readonly string[], right: readonly string[]): boolean {
  const diff = diffArray(left, right);
  return diff.added.length > 0 || diff.removed.length > 0;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
