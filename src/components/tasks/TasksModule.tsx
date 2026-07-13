"use client";

import { useCallback, useMemo, useState } from "react";
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

type Filter = "all" | TaskStatusGroup;

const FILTERS: { label: string; value: Filter }[] = [
  { label: "All", value: "all" },
  { label: "Queued", value: "queued" },
  { label: "Active", value: "active" },
  { label: "Waiting", value: "waiting" },
  { label: "Blocked", value: "blocked" },
  { label: "Done", value: "done" },
];

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
  const { tasks, loading, error, createTask, transition, getTask } = useAgentTasks();
  const { toast } = useToast();

  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ task: AgentTask; activity: AgentTaskActivity[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((t) => taskStatusGroup(t.status) === filter)),
    [tasks, filter],
  );

  const openTask = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setDetailLoading(true);
      const result = await getTask(id);
      setDetail(result);
      setDetailLoading(false);
      if (!result) toast("Could not load task detail.", "error", "Tasks");
    },
    [getTask, toast],
  );

  const submit = useCallback(async () => {
    const objective = draft.trim();
    if (!objective) return;
    setCreating(true);
    const task = await createTask(objective);
    setCreating(false);
    if (task) {
      setDraft("");
      toast("Task created.", "success", "Tasks");
      void openTask(task.id);
    } else {
      toast("Could not create task.", "error", "Tasks");
    }
  }, [draft, createTask, toast, openTask]);

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
      </Card>

      <div className="divider" />

      <div style={{ marginBottom: 12 }}>
        <Seg options={FILTERS} value={filter} onChange={setFilter} />
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
                onClick={() => void openTask(t.id)}
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
          {!selectedId ? (
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
