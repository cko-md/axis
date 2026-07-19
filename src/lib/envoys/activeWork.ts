/**
 * Truthful active-work projection (Wave 15.4, VE-RISK-010).
 *
 * One pure adapter turns the three existing owner-scoped API results
 * (agent tasks, routine runs, approvals) into a single typed HUD model with
 * explicit per-section degradation. A failed section reads as "degraded",
 * never as empty; counts come only from real rows; there is no synthesized
 * progress (percent requires a true denominator, which none of these
 * records currently carry — so none is shown). Every item deep-links to the
 * exact surface that owns it. Pure: no fetch, no React.
 */

export type EnvoySectionKey = "approvals" | "tasks" | "runs";

export type EnvoySectionState<Item> =
  | { status: "ok"; items: Item[] }
  | { status: "degraded"; code: string };

export type EnvoyWorkItem = {
  kind: "approval" | "task" | "run";
  id: string;
  title: string;
  statusLabel: string;
  /** Deterministic rank: lower = more urgent. */
  rank: number;
  updatedAt: string;
  href: string;
};

export type EnvoyActiveWork = {
  approvals: EnvoySectionState<EnvoyWorkItem>;
  tasks: EnvoySectionState<EnvoyWorkItem>;
  runs: EnvoySectionState<EnvoyWorkItem>;
  /** All ok-section items, deterministically ranked. */
  ranked: EnvoyWorkItem[];
  /** True count of attention-needing items across ok sections only. */
  attentionCount: number;
  degradedSections: EnvoySectionKey[];
};

export type RawTask = {
  id: string;
  objective?: string | null;
  status?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type RawApproval = {
  id: string;
  proposed_action?: { summary?: string | null } | null;
  action_class?: string | null;
  status?: string | null;
  created_at?: string | null;
};

export type RawRun = {
  id: string;
  routine_key?: string | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

export type EnvoySectionInput<Raw> =
  | { ok: true; rows: Raw[] }
  | { ok: false; code: string };

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "rejected", "expired"]);
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_for_approval", "blocked"]);

/** Deterministic urgency ranking. Lower ranks sort first. */
function taskRank(status: string): number {
  if (status === "waiting_approval") return 1;
  if (status === "executing") return 2;
  if (status === "blocked") return 2;
  return 4; // queued/planning/other non-terminal
}

function runRank(status: string): number {
  if (status === "waiting_for_approval") return 1;
  if (status === "blocked") return 2;
  return 5; // running
}

function text(value: string | null | undefined, fallback: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

function time(value: string | null | undefined): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : "";
}

export function projectEnvoyActiveWork(input: {
  tasks: EnvoySectionInput<RawTask>;
  approvals: EnvoySectionInput<RawApproval>;
  runs: EnvoySectionInput<RawRun>;
}): EnvoyActiveWork {
  const approvals: EnvoySectionState<EnvoyWorkItem> = input.approvals.ok
    ? {
        status: "ok",
        items: input.approvals.rows
          .filter((row) => row.status === "pending" || row.status === "approved")
          .map((row) => ({
            kind: "approval" as const,
            id: row.id,
            title: text(row.proposed_action?.summary, text(row.action_class, "Approval")),
            statusLabel: row.status === "pending" ? "Needs decision" : "Approved, not executed",
            rank: row.status === "pending" ? 0 : 3,
            updatedAt: time(row.created_at),
            href: "/approvals",
          })),
      }
    : { status: "degraded", code: input.approvals.code };

  const tasks: EnvoySectionState<EnvoyWorkItem> = input.tasks.ok
    ? {
        status: "ok",
        items: input.tasks.rows
          .filter((row) => typeof row.status === "string" && !TERMINAL_TASK_STATUSES.has(row.status))
          .map((row) => ({
            kind: "task" as const,
            id: row.id,
            title: text(row.objective, "Task"),
            statusLabel: text(row.status, "unknown"),
            rank: taskRank(row.status ?? ""),
            updatedAt: time(row.updated_at ?? row.created_at),
            href: "/tasks",
          })),
      }
    : { status: "degraded", code: input.tasks.code };

  const runs: EnvoySectionState<EnvoyWorkItem> = input.runs.ok
    ? {
        status: "ok",
        items: input.runs.rows
          .filter((row) => typeof row.status === "string" && ACTIVE_RUN_STATUSES.has(row.status))
          .map((row) => ({
            kind: "run" as const,
            id: row.id,
            title: text(row.routine_key, "Routine run"),
            statusLabel: text(row.status, "unknown"),
            rank: runRank(row.status ?? ""),
            updatedAt: time(row.started_at),
            href: "/tasks",
          })),
      }
    : { status: "degraded", code: input.runs.code };

  const ranked = [
    ...(approvals.status === "ok" ? approvals.items : []),
    ...(tasks.status === "ok" ? tasks.items : []),
    ...(runs.status === "ok" ? runs.items : []),
  ].sort((left, right) => (
    left.rank - right.rank
    || (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));

  const degradedSections = ([
    ["approvals", approvals],
    ["tasks", tasks],
    ["runs", runs],
  ] as const)
    .filter(([, section]) => section.status === "degraded")
    .map(([key]) => key);

  return {
    approvals,
    tasks,
    runs,
    ranked,
    attentionCount: ranked.filter((item) => item.rank <= 2).length,
    degradedSections,
  };
}
