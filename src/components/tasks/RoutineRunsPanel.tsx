"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { useToast } from "@/components/ui/Toast";
import { relativeTimeShort } from "@/lib/fund/freshnessBadge";
import {
  formatRoutineKey,
  jsonPreview,
  routineRunStatusLabel,
  routineRunTone,
  routineRunToneColor,
  summarizeRoutineOutput,
} from "@/lib/routines/runHistoryView";

type RunRow = {
  id: string;
  routine_key: string;
  routine_version?: number;
  status: string;
  trigger?: string;
  output: unknown;
  actual_cost_usd?: number | null;
  paused_step_key?: string | null;
  approval_id?: string | null;
  idempotency_key?: string | null;
  started_at: string;
  completed_at: string | null;
};

type StepRow = {
  id: string;
  step_key: string;
  ordinal: number;
  status: string;
  input_snapshot: unknown;
  output_snapshot: unknown;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
};

type RunDetail = {
  run: RunRow & {
    input_snapshot: unknown;
    error: string | null;
  };
  steps: StepRow[];
};

/**
 * Durable-run history (§15.5). Self-fetches /api/routines/runs; bump
 * `refreshKey` to reload after triggering a routine. Rows open the persisted
 * run detail and ordered step snapshots from the server-owned audit trail.
 */
export function RoutineRunsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/routines/runs").catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } else {
      setError("LOAD_FAILED");
    }
    setLoaded(true);
  }, []);

  const openRun = useCallback(
    async (id: string) => {
      setSelectedRunId(id);
      setDetailLoading(true);
      setDetail(null);
      const res = await fetch(`/api/routines/runs?runId=${encodeURIComponent(id)}`).catch(() => null);
      if (!res?.ok) {
        setDetailLoading(false);
        toast("Could not load routine run detail.", "error", "Routines");
        return;
      }
      const data = await res.json();
      setDetail({ run: data.run as RunDetail["run"], steps: Array.isArray(data.steps) ? data.steps : [] });
      setDetailLoading(false);
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const resumeSelectedRun = useCallback(async () => {
    if (!selectedRunId) return;
    setResuming(true);
    const res = await fetch(`/api/routines/runs/${encodeURIComponent(selectedRunId)}/resume`, {
      method: "POST",
    }).catch(() => null);
    setResuming(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => ({}))) as { error?: string; reason?: string };
      const reason = body.reason === "STEP_UP_REQUIRED" ? "Verify the approval with passkey first." : "Resume is not ready yet.";
      toast(reason, "error", body.error ?? "Routines");
      return;
    }
    const body = (await res.json()) as { status?: string };
    toast(`Run ${routineRunStatusLabel(body.status ?? "completed").toLowerCase()}.`, "success", "Routines");
    await load();
    await openRun(selectedRunId);
  }, [load, openRun, selectedRunId, toast]);

  if (!loaded) return <SkeletonCard rows={3} />;

  if (error) {
    return (
      <StatusCallout kind="error" title="Couldn’t load routine runs">
        The run history is unavailable right now.
      </StatusCallout>
    );
  }

  if (runs.length === 0) return null;

  return (
    <Card>
      <div className="seclabel" style={{ marginBottom: 8 }}>Recent routine runs</div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {runs.slice(0, 6).map((r) => {
          const color = routineRunToneColor(routineRunTone(r.status));
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => void openRun(r.id)}
                aria-pressed={selectedRunId === r.id}
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: "8px minmax(140px, 1fr) minmax(96px, auto) minmax(120px, 1fr) auto",
                  gap: 10,
                  alignItems: "center",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border:
                    selectedRunId === r.id
                      ? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
                      : "1px solid var(--line)",
                  background: selectedRunId === r.id ? "var(--surface-2)" : "transparent",
                  fontSize: 12.5,
                }}
              >
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
                <span style={{ color: "var(--ink)", minWidth: 0 }}>{formatRoutineKey(r.routine_key)}</span>
                <span style={{ color, fontWeight: 600 }}>{routineRunStatusLabel(r.status)}</span>
                <span style={{ color: "var(--ink-faint)", minWidth: 0 }}>{summarizeRoutineOutput(r.output)}</span>
                <span style={{ color: "var(--ink-faint)", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                  {relativeTimeShort(r.started_at) ?? "-"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {selectedRunId && (
        <>
          <div className="divider" style={{ margin: "14px 0" }} />
          {detailLoading ? (
            <SkeletonCard rows={4} />
          ) : !detail ? (
            <StatusCallout kind="info" title="Select a run">
              Pick a routine run to inspect its steps.
            </StatusCallout>
          ) : (
            <RunDetailView detail={detail} resuming={resuming} onResume={() => void resumeSelectedRun()} />
          )}
        </>
      )}
    </Card>
  );
}

function RunDetailView({
  detail,
  resuming,
  onResume,
}: {
  detail: RunDetail;
  resuming: boolean;
  onResume: () => void;
}) {
  const statusColor = routineRunToneColor(routineRunTone(detail.run.status));
  const canResume = detail.run.status === "waiting_for_approval" && !!detail.run.approval_id;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
        <div>
          <h3 className="sec" style={{ margin: 0 }}>{formatRoutineKey(detail.run.routine_key)}</h3>
          <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4 }}>
            v{detail.run.routine_version ?? 1} · {detail.run.trigger ?? "manual"} · Started{" "}
            {relativeTimeShort(detail.run.started_at) ?? "-"}
          </div>
        </div>
        <span style={{ color: statusColor, fontSize: 12, fontWeight: 700 }}>
          {routineRunStatusLabel(detail.run.status)}
        </span>
      </div>

      {canResume && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button variant="secondary" onClick={onResume} disabled={resuming}>
            {resuming ? "Resuming..." : "Resume run"}
          </Button>
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            Approval {shortId(detail.run.approval_id)} · paused at {detail.run.paused_step_key}
          </span>
        </div>
      )}

      {detail.run.error && (
        <p style={{ margin: "12px 0 0", color: "var(--down)", fontSize: 12 }}>{detail.run.error}</p>
      )}

      <div className="divider" style={{ margin: "14px 0" }} />
      <div className="seclabel" style={{ marginBottom: 8 }}>Steps</div>
      {detail.steps.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: 0 }}>No steps recorded.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {detail.steps.map((step) => (
            <li key={step.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ color: "var(--ink)", fontSize: 12.5, fontWeight: 600 }}>
                  {step.ordinal}. {formatRoutineKey(step.step_key)}
                </span>
                <span style={{ color: routineRunToneColor(stepTone(step.status)), fontSize: 11.5, fontWeight: 700 }}>
                  {routineRunStatusLabel(step.status)}
                </span>
              </div>
              <div style={{ color: "var(--ink-faint)", fontSize: 10.5, marginTop: 4, fontFamily: "var(--mono)" }}>
                {relativeTimeShort(step.started_at) ?? "-"} {step.completed_at ? `-> ${relativeTimeShort(step.completed_at) ?? "-"}` : ""}
              </div>
              {step.error && <p style={{ color: "var(--down)", fontSize: 12, margin: "8px 0 0" }}>{step.error}</p>}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: "var(--ink-dim)", fontSize: 11.5 }}>
                  Snapshot
                </summary>
                <pre
                  style={{
                    margin: "8px 0 0",
                    maxHeight: 260,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 10.5,
                    color: "var(--ink-dim)",
                    background: "var(--surface-2)",
                    border: "1px solid var(--line)",
                    borderRadius: 8,
                    padding: 10,
                  }}
                >
                  {jsonPreview({ input: step.input_snapshot, output: step.output_snapshot })}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function stepTone(status: string) {
  if (status === "succeeded" || status === "skipped") return "done";
  if (status === "failed") return "failed";
  if (status === "running") return "active";
  return "neutral";
}

function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 8)}...` : "-";
}
