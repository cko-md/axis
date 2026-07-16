"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Seg } from "@/components/ui/Seg";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { useAgentTasks, type AgentTask, type AgentTaskActivity } from "@/lib/hooks/useAgentTasks";
import { TASK_STATUSES, TASK_TRANSITIONS, isTerminal, type FinancialTaskStatus } from "@/lib/tasks/taskState";
import {
  taskStatusGroup,
  taskStatusLabel,
  taskStatusTone,
  taskToneColor,
  type TaskStatusGroup,
} from "@/lib/tasks/taskStatusView";
import { relativeTimeShort } from "@/lib/fund/freshnessBadge";
import { RoutineRunsPanel } from "@/components/tasks/RoutineRunsPanel";
import { actionClassLabel, approvalStatusLabel, type ApprovalStatus } from "@/lib/security/approvalCardView";
import type { ActionClass } from "@/lib/security/actionPolicy";
import { resolveTaskSelection, taskSelectionHref } from "@/lib/entities/taskSelection";

type TaskApproval = {
  id: string;
  action_class: ActionClass;
  status: ApprovalStatus;
  proposed_action: { summary?: string } | null;
};

type Filter = "all" | TaskStatusGroup;

const ACTION_CLASSES: ReadonlySet<string> = new Set([
  "READ",
  "DRAFT",
  "SIMULATE",
  "INTERNAL_WRITE",
  "EXTERNAL_COMMUNICATION",
  "FINANCIAL_EXECUTION",
  "DESTRUCTIVE_ADMIN",
]);

const APPROVAL_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "denied",
  "expired",
  "executed",
]);

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Queued", value: "queued" },
  { label: "Active", value: "active" },
  { label: "Waiting", value: "waiting" },
  { label: "Blocked", value: "blocked" },
  { label: "Done", value: "done" },
];

function isTaskApproval(value: unknown): value is TaskApproval {
  if (!value || typeof value !== "object") return false;
  const approval = value as Record<string, unknown>;
  const proposedAction = approval.proposed_action;
  if (
    proposedAction !== null &&
    (typeof proposedAction !== "object" ||
      Array.isArray(proposedAction) ||
      ("summary" in proposedAction &&
        (proposedAction as Record<string, unknown>).summary !== undefined &&
        typeof (proposedAction as Record<string, unknown>).summary !== "string"))
  ) {
    return false;
  }
  return (
    typeof approval.id === "string" &&
    typeof approval.action_class === "string" &&
    ACTION_CLASSES.has(approval.action_class) &&
    typeof approval.status === "string" &&
    APPROVAL_STATUSES.has(approval.status)
  );
}

function reportTaskFailure(
  operation: string,
  failureKind: "network" | "server" | "invalid_response",
  status?: number,
) {
  Sentry.captureException(new Error(`Tasks ${operation} failed`), {
    tags: {
      area: "tasks",
      operation,
      failure_kind: failureKind,
      ...(status == null ? {} : { status: String(status) }),
    },
  });
}

function StatusChip({ status }: { status: FinancialTaskStatus }) {
  const color = taskToneColor(taskStatusTone(status));
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1,
        padding: "3px 8px",
        borderRadius: 999,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: color }} />
      {taskStatusLabel(status)}
    </span>
  );
}

export function TasksModule() {
  const { tasks, loading, error, reload, createTask, transition, getTask } = useAgentTasks();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const taskParam = searchParams.get("task");

  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const [runsRefresh, setRunsRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ task: AgentTask; activity: AgentTaskActivity[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [taskApprovals, setTaskApprovals] = useState<TaskApproval[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectionError, setSelectionError] = useState<"invalid" | "not_found" | null>(null);
  const hydratedSelectionRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const approvalsRequestRef = useRef(0);

  const taskSelection = useMemo(
    () => resolveTaskSelection(taskParam, tasks.map((task) => task.id), !loading && !error),
    [taskParam, tasks, loading, error],
  );

  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((t) => taskStatusGroup(t.status) === filter)),
    [tasks, filter],
  );

  const loadTaskApprovals = useCallback(async (id: string, detailRequestId: number) => {
    const approvalsRequestId = ++approvalsRequestRef.current;
    const isCurrentRequest = () =>
      detailRequestRef.current === detailRequestId &&
      approvalsRequestRef.current === approvalsRequestId;

    setApprovalsLoading(true);
    setApprovalsError(null);
    try {
      const response = await fetch(`/api/approvals?taskId=${encodeURIComponent(id)}`);
      if (!isCurrentRequest()) return;
      if (!response.ok) {
        if (response.status >= 500) {
          reportTaskFailure("load_linked_approvals", "server", response.status);
        }
        setTaskApprovals([]);
        setApprovalsError("Linked approvals could not be loaded.");
        return;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (!isCurrentRequest()) return;
        reportTaskFailure("parse_linked_approvals", "invalid_response", response.status);
        setTaskApprovals([]);
        setApprovalsError("Linked approvals returned an invalid response.");
        return;
      }
      if (!isCurrentRequest()) return;
      const approvals =
        payload && typeof payload === "object"
          ? (payload as { approvals?: unknown }).approvals
          : undefined;
      if (!Array.isArray(approvals) || !approvals.every(isTaskApproval)) {
        reportTaskFailure("parse_linked_approvals", "invalid_response", response.status);
        setTaskApprovals([]);
        setApprovalsError("Linked approvals returned an invalid response.");
        return;
      }
      setTaskApprovals(approvals);
    } catch {
      if (!isCurrentRequest()) return;
      reportTaskFailure("load_linked_approvals", "network");
      setTaskApprovals([]);
      setApprovalsError("Linked approvals could not reach AXIS. Check your connection and retry.");
    } finally {
      if (isCurrentRequest()) setApprovalsLoading(false);
    }
  }, []);

  const openTask = useCallback(
    async (id: string) => {
      const requestId = ++detailRequestRef.current;
      approvalsRequestRef.current += 1;
      setSelectedId(id);
      setDetailLoading(true);
      setTaskApprovals([]);
      setApprovalsLoading(false);
      setApprovalsError(null);
      const result = await getTask(id);
      if (detailRequestRef.current !== requestId) return;
      setDetail(result);
      setDetailLoading(false);
      if (!result) {
        toast("Could not load task detail.", "error", "Tasks");
        return;
      }
      void loadTaskApprovals(id, requestId);
    },
    [getTask, loadTaskApprovals, toast],
  );

  const selectTask = useCallback(
    (id: string | null) => {
      router.push(taskSelectionHref(pathname, query, id), { scroll: false });
    },
    [pathname, query, router],
  );

  const handleTaskSelection = useCallback(
    (id: string) => {
      if (taskSelection.status === "ready" && taskSelection.ref.id === id) {
        void openTask(id);
        return;
      }
      selectTask(id);
    },
    [openTask, selectTask, taskSelection],
  );

  useEffect(() => {
    if (taskSelection.status === "pending") {
      setSelectedId(taskSelection.ref.id);
      setDetail(null);
      setDetailLoading(true);
      setSelectionError(null);
      return;
    }

    if (taskSelection.status === "none" || taskSelection.status === "invalid") {
      detailRequestRef.current += 1;
      hydratedSelectionRef.current = null;
      setSelectedId(null);
      setDetail(null);
      setDetailLoading(false);
      setTaskApprovals([]);
      setApprovalsLoading(false);
      setApprovalsError(null);
      setSelectionError(taskSelection.status === "invalid" ? "invalid" : null);
      return;
    }

    if (taskSelection.status === "not_found") {
      detailRequestRef.current += 1;
      hydratedSelectionRef.current = null;
      setSelectedId(taskSelection.ref.id);
      setDetail(null);
      setDetailLoading(false);
      setTaskApprovals([]);
      setApprovalsLoading(false);
      setApprovalsError(null);
      setSelectionError("not_found");
      return;
    }

    setSelectionError(null);
    setSelectedId(taskSelection.ref.id);
    if (hydratedSelectionRef.current === taskSelection.ref.id) return;
    hydratedSelectionRef.current = taskSelection.ref.id;
    void openTask(taskSelection.ref.id);
  }, [taskSelection, openTask]);

  const submit = useCallback(async () => {
    const objective = draft.trim();
    if (!objective) return;
    setCreating(true);
    const task = await createTask(objective);
    setCreating(false);
    if (task) {
      setDraft("");
      toast("Task created.", "success", "Tasks");
      selectTask(task.id);
    } else {
      toast("Could not create task.", "error", "Tasks");
    }
  }, [draft, createTask, toast, selectTask]);

  const runConcentrationCheck = useCallback(async () => {
    setRunning(true);
    setRoutineError(null);
    try {
      const response = await fetch("/api/routines/concentration-check", { method: "POST" });
      if (!response.ok) {
        if (response.status >= 500) {
          reportTaskFailure("run_concentration_check", "server", response.status);
        } else {
          Sentry.addBreadcrumb({
            category: "tasks",
            message: "Concentration check request rejected",
            level: "info",
            data: {
              operation: "run_concentration_check",
              status: response.status,
            },
          });
        }
        const message = "Couldn’t run the concentration check. Retry when the service is available.";
        setRoutineError(message);
        toast(message, "error", "Routines");
        return;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        reportTaskFailure("parse_concentration_check", "invalid_response", response.status);
        const message = "The concentration check returned an invalid response. Please retry.";
        setRoutineError(message);
        toast(message, "error", "Routines");
        return;
      }
      if (!payload || typeof payload !== "object") {
        reportTaskFailure("parse_concentration_check", "invalid_response", response.status);
        const message = "The concentration check returned an invalid response. Please retry.";
        setRoutineError(message);
        toast(message, "error", "Routines");
        return;
      }
      const data = payload as {
        status?: unknown;
        approvalId?: unknown;
        created?: unknown;
        skipped?: unknown;
        breaches?: unknown;
      };
      if (data.status === "waiting_for_approval" && typeof data.approvalId === "string") {
        setRunsRefresh((n) => n + 1);
        toast("Concentration check is waiting for approval.", "info", "Routines");
        return;
      }
      if (
        !Array.isArray(data.created) ||
        typeof data.skipped !== "number" ||
        typeof data.breaches !== "number"
      ) {
        reportTaskFailure("parse_concentration_check", "invalid_response", response.status);
        const message = "The concentration check returned an invalid response. Please retry.";
        setRoutineError(message);
        toast(message, "error", "Routines");
        return;
      }

      setRunsRefresh((n) => n + 1);
      const createdCount = Array.isArray(data.created) ? data.created.length : 0;
      if (createdCount > 0) {
        toast(`Concentration check: ${createdCount} task(s) created.`, "success", "Routines");
        void reload();
      } else if (typeof data.breaches === "number" && data.breaches > 0) {
        toast("Concentration check: breaches already tracked.", "info", "Routines");
      } else {
        toast("Concentration check: no positions over target.", "success", "Routines");
      }
    } catch {
      reportTaskFailure("run_concentration_check", "network");
      const message = "The concentration check could not reach AXIS. Check your connection and retry.";
      setRoutineError(message);
      toast(message, "error", "Routines");
    } finally {
      setRunning(false);
    }
  }, [toast, reload]);

  const move = useCallback(
    async (id: string, status: FinancialTaskStatus) => {
      setBusy(true);
      const result = await transition(id, status);
      setBusy(false);
      if (result.ok) {
        toast(`Moved to “${taskStatusLabel(status)}”.`, "success", "Tasks");
        if (selectedId === id) void openTask(id);
      } else if (result.reason === "ILLEGAL_TRANSITION") {
        toast("That status change isn't allowed from here.", "error", "Tasks");
      } else {
        toast("Could not update the task.", "error", "Tasks");
      }
    },
    [transition, toast, selectedId, openTask],
  );

  return (
    <div>
      <Card tick>
        <div className="seclabel">Agent Tasks</div>
        <p style={{ fontSize: 12.5, color: "var(--ink-dim)", margin: "4px 0 12px", maxWidth: 640 }}>
          The durable queue of work the assistant does for you. Each task keeps its own state, evidence,
          and activity across pauses — chat is just an interface to it.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="New task objective — e.g. “Investigate the $4,900 unidentified transaction”"
            aria-label="New task objective"
            className="rounded-md border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-sm"
            style={{ flex: 1, minWidth: 260 }}
          />
          <Button variant="primary" onClick={() => void submit()} disabled={creating || !draft.trim()}>
            {creating ? "Adding…" : "Add task"}
          </Button>
        </div>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="secondary" onClick={() => void runConcentrationCheck()} disabled={running}>
            {running ? "Running…" : "Run concentration check"}
          </Button>
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            Deterministic review of your holdings — opens a task for any position over target weight.
          </span>
        </div>
        {routineError && (
          <div
            role="alert"
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--status-error)",
              fontSize: 12,
            }}
          >
            <span>{routineError}</span>
            <button
              type="button"
              className="underline"
              onClick={() => void runConcentrationCheck()}
              disabled={running}
            >
              Retry
            </button>
          </div>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <RoutineRunsPanel refreshKey={runsRefresh} />
      </div>

      <div className="divider" />

      <div style={{ marginBottom: 12 }}>
        <Seg ariaLabel="Task status filter" options={FILTERS} value={filter} onChange={setFilter} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 1fr) minmax(300px, 1.1fr)", gap: 16, alignItems: "start" }}>
        {/* List */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {loading ? (
            <SkeletonCard rows={4} />
          ) : error === "SIGNED_OUT" ? (
            <StatusCallout kind="setup_required" title="Sign in to use Tasks">
              Agent tasks are private to your account.
            </StatusCallout>
          ) : error ? (
            <StatusCallout kind="error" title="Couldn’t load tasks">
              Something went wrong fetching your tasks. Reload to try again.
            </StatusCallout>
          ) : visible.length === 0 ? (
            <StatusCallout kind="empty" title={filter === "all" ? "No tasks yet" : "Nothing here"}>
              {filter === "all"
                ? "Create your first task above to start the queue."
                : "No tasks match this filter."}
            </StatusCallout>
          ) : (
            visible.map((t) => (
              <button
                key={t.id}
                onClick={() => handleTaskSelection(t.id)}
                className="card"
                style={{
                  textAlign: "left",
                  padding: 14,
                  cursor: "pointer",
                  border:
                    selectedId === t.id
                      ? "1px solid color-mix(in srgb, var(--accent) 55%, transparent)"
                      : undefined,
                }}
                aria-pressed={selectedId === t.id}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
                  <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>{t.objective}</span>
                  <StatusChip status={t.status} />
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 6 }}>
                  Updated {relativeTimeShort(t.updated_at) ?? "—"}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        <div>
          {selectionError === "invalid" ? (
            <StatusCallout kind="error" title="Invalid task link">
              <span>This link doesn’t identify a valid task.</span>{" "}
              <button type="button" onClick={() => selectTask(null)} className="underline">
                Clear the task link
              </button>
              .
            </StatusCallout>
          ) : selectionError === "not_found" ? (
            <StatusCallout kind="error" title="Task not found">
              <span>This task isn’t available.</span>{" "}
              <button type="button" onClick={() => selectTask(null)} className="underline">
                Return to the task list
              </button>
              .
            </StatusCallout>
          ) : !selectedId ? (
            <StatusCallout kind="info" title="Select a task">
              Choose a task to see its activity and move it through its lifecycle.
            </StatusCallout>
          ) : detailLoading ? (
            <SkeletonCard rows={5} />
          ) : !detail ? (
            <StatusCallout kind="error" title="Couldn’t load that task">
              Try selecting it again.
            </StatusCallout>
          ) : (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "start" }}>
                <h2 className="sec" style={{ margin: 0 }}>{detail.task.objective}</h2>
                <StatusChip status={detail.task.status} />
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 6 }}>
                Created {relativeTimeShort(detail.task.created_at) ?? "—"} · Updated{" "}
                {relativeTimeShort(detail.task.updated_at) ?? "—"}
              </div>

              {/* Lifecycle controls — only the legal next statuses (taskState). */}
              {!isTerminal(detail.task.status) && (
                <div style={{ marginTop: 14 }}>
                  <div className="seclabel" style={{ marginBottom: 6 }}>Move to</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {TASK_TRANSITIONS[detail.task.status].map((next) => (
                      <Button
                        key={next}
                        variant={next === "failed" || next === "cancelled" ? "danger" : "secondary"}
                        onClick={() => void move(detail.task.id, next)}
                        disabled={busy}
                      >
                        {taskStatusLabel(next)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              <div className="divider" style={{ margin: "14px 0" }} />
              <div className="seclabel" style={{ marginBottom: 8 }}>
                Approvals · <a href="/approvals" style={{ color: "var(--accent)" }}>review queue</a>
              </div>
              {approvalsLoading ? (
                <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>
                  Loading linked approvals…
                </p>
              ) : approvalsError ? (
                <div
                  role="alert"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "var(--status-error)",
                  }}
                >
                  <span>{approvalsError}</span>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void loadTaskApprovals(detail.task.id, detailRequestRef.current)}
                  >
                    Retry
                  </button>
                </div>
              ) : taskApprovals.length > 0 ? (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {taskApprovals.map((a) => (
                    <li key={a.id} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "baseline" }}>
                      <span style={{ color: "var(--ink-faint)", minWidth: 118 }}>{actionClassLabel(a.action_class)}</span>
                      <span style={{ color: "var(--ink)", flex: 1 }}>{a.proposed_action?.summary ?? "—"}</span>
                      <span style={{ color: "var(--ink-dim)", fontWeight: 600 }}>{approvalStatusLabel(a.status)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-faint)" }}>
                  No linked approvals.
                </p>
              )}

              <div className="divider" style={{ margin: "14px 0" }} />
              <div className="seclabel" style={{ marginBottom: 8 }}>Activity</div>
              {detail.activity.length === 0 ? (
                <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>No activity recorded yet.</p>
              ) : (
                <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {detail.activity.map((a) => (
                    <li key={a.id} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                      <span style={{ color: "var(--ink-faint)", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                        {relativeTimeShort(a.created_at) ?? "—"}
                      </span>
                      <span style={{ color: "var(--ink-dim)" }}>{describeActivity(a)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function labelFor(status: string): string {
  return (TASK_STATUSES as readonly string[]).includes(status)
    ? taskStatusLabel(status as FinancialTaskStatus)
    : status;
}

function describeActivity(a: AgentTaskActivity): string {
  const detail = a.detail ?? {};
  if (a.kind === "status_change") {
    const to = detail.to == null ? "?" : labelFor(String(detail.to));
    return detail.from == null ? `Created (${to})` : `${labelFor(String(detail.from))} → ${to}`;
  }
  return a.kind.replace(/_/g, " ");
}
