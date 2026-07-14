"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { relativeTimeShort } from "@/lib/fund/freshnessBadge";

type RunRow = {
  id: string;
  routine_key: string;
  status: string;
  output: { created?: unknown[]; skipped?: number; breaches?: number } | null;
  started_at: string;
  completed_at: string | null;
};

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--up)",
  partial: "var(--clay-2, var(--gold-deep))",
  failed: "var(--down)",
  running: "var(--accent)",
  cancelled: "var(--ink-faint)",
};

/**
 * Compact durable-run history (§15.5). Self-fetches /api/routines/runs; bump
 * `refreshKey` to reload after triggering a routine. Shows nothing until at
 * least one run exists (honest empty — no fabricated history).
 */
export function RoutineRunsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/routines/runs").catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!loaded || runs.length === 0) return null;

  return (
    <Card>
      <div className="seclabel" style={{ marginBottom: 8 }}>Recent routine runs</div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {runs.slice(0, 6).map((r) => {
          const color = STATUS_COLOR[r.status] ?? "var(--ink-faint)";
          const createdCount = Array.isArray(r.output?.created) ? r.output!.created!.length : 0;
          return (
            <li key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
              <span style={{ color: "var(--ink)", minWidth: 150 }}>{r.routine_key.replace(/_/g, " ")}</span>
              <span style={{ color, fontWeight: 600, minWidth: 74 }}>{r.status}</span>
              <span style={{ color: "var(--ink-faint)", flex: 1 }}>
                {createdCount > 0 ? `${createdCount} task(s)` : r.output?.breaches ? "no new tasks" : "no breaches"}
              </span>
              <span style={{ color: "var(--ink-faint)", fontFamily: "var(--mono)", fontSize: 10.5 }}>
                {relativeTimeShort(r.started_at) ?? "—"}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
