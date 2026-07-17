"use client";

import { useCallback, useEffect, useState } from "react";
import type { FinancialTaskStatus } from "@/lib/tasks/taskState";

/**
 * Client data hook for the durable agent-Task workbench. Talks to the
 * /api/agent-tasks routes (which own auth, RLS, and the server-side
 * assertTransition gate) rather than Supabase directly, so the transition
 * rules live in exactly one place.
 */

export type AgentTask = {
  id: string;
  objective: string;
  status: FinancialTaskStatus;
  context: Record<string, unknown> | null;
  source_routine_id: string | null;
  source_skill: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AgentTaskActivity = {
  id: string;
  kind: string;
  detail: Record<string, unknown> | null;
  created_at: string;
};

export type AgentTaskDetailResult =
  | { ok: true; task: AgentTask; activity: AgentTaskActivity[] }
  | { ok: false; reason: "NETWORK" | "UNAVAILABLE" | "NOT_FOUND" | "INVALID_RESPONSE"; status?: number };

export function useAgentTasks() {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-tasks");
      if (res.status === 401) {
        setTasks([]);
        setError("SIGNED_OUT");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch {
      setError("LOAD_FAILED");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Create a task; returns the new task or null (caller surfaces the error). */
  const createTask = useCallback(
    async (objective: string): Promise<AgentTask | null> => {
      const res = await fetch("/api/agent-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective }),
      }).catch(() => null);
      if (!res?.ok) return null;
      const data = await res.json();
      const task = data.task as AgentTask | undefined;
      if (task) setTasks((prev) => [task, ...prev]);
      return task ?? null;
    },
    [],
  );

  /**
   * Move a task to a new status. Returns { ok } plus a reason on failure so the
   * UI can distinguish an illegal transition (409) from a network/server error.
   */
  const transition = useCallback(
    async (id: string, status: FinancialTaskStatus): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/agent-tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }).catch(() => null);
      if (!res) return { ok: false, reason: "NETWORK" };
      if (res.ok) {
        const data = await res.json();
        const updated = data.task as AgentTask | undefined;
        if (updated) setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
        return { ok: true };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, reason: body.error ?? `HTTP_${res.status}` };
    },
    [],
  );

  const getTask = useCallback(
    async (id: string): Promise<AgentTaskDetailResult> => {
      const res = await fetch(`/api/agent-tasks/${id}`).catch(() => null);
      if (!res) return { ok: false, reason: "NETWORK" };
      if (!res.ok) {
        return {
          ok: false,
          reason: res.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
          status: res.status,
        };
      }
      const data = await res.json().catch(() => null) as {
        task?: AgentTask;
        activity?: AgentTaskActivity[];
      } | null;
      if (!data?.task || !Array.isArray(data.activity)) {
        return { ok: false, reason: "INVALID_RESPONSE", status: res.status };
      }
      return { ok: true, task: data.task, activity: data.activity };
    },
    [],
  );

  return { tasks, loading, error, reload, createTask, transition, getTask };
}
