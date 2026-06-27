"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type TaskCategory = "research" | "clinical" | "life" | "personal";
export type TaskPriority = "hi" | "med" | "lo";
export type TaskStatus = "open" | "done" | "overdue";

export type Task = {
  id: string;
  user_id: string;
  title: string;
  priority: TaskPriority;
  effort: string | null;
  deadline: string | null;
  category: TaskCategory;
  status: TaskStatus;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const DONE_HIDE_MS = 18 * 60 * 60 * 1000; // 18 hours

export function useTasks() {
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setTasks([]);
      setLoading(false);
      return;
    }
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    if (error || !data) { setLoading(false); return; }
    const now = Date.now();
    const normalized = data.map((t) => {
      if (t.status === "open" && t.deadline && new Date(t.deadline).getTime() < now) {
        return { ...t, status: "overdue" as TaskStatus };
      }
      return t as Task;
    });
    setTasks(normalized);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "tasks", userId, refresh);

  const addTask = useCallback(async (partial: Partial<Task> & { title: string; category: TaskCategory }) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        user_id: user.id,
        title: partial.title,
        category: partial.category,
        priority: partial.priority ?? "med",
        effort: partial.effort ?? null,
        deadline: partial.deadline ?? null,
        status: "open",
        sort_order: tasks.length,
      })
      .select()
      .single();
    if (!error && data) {
      setTasks((prev) => [...prev, data as Task]);
      return data as Task;
    }
    return null;
  }, [supabase, tasks.length]);

  const updateTask = useCallback(async (id: string, patch: Partial<Task>) => {
    const { data, error } = await supabase.from("tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (!error && data) setTasks((prev) => prev.map((t) => (t.id === id ? (data as Task) : t)));
  }, [supabase]);

  const deleteTask = useCallback(async (id: string) => {
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (!error) setTasks((prev) => prev.filter((t) => t.id !== id));
  }, [supabase]);

  const toggleDone = useCallback(async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const isDone = t.status === "done";
    await updateTask(id, {
      status: isDone ? "open" : "done",
      completed_at: isDone ? null : new Date().toISOString(),
    });
  }, [tasks, updateTask]);

  return { tasks, loading, refresh, addTask, updateTask, deleteTask, toggleDone };
}

export function rankTasks(tasks: Task[]) {
  const NO_DEADLINE = Date.UTC(2100, 0, 1);
  const score = (t: Task) => {
    const pri = t.priority === "hi" ? 3 : t.priority === "med" ? 2 : 1;
    const dl = t.deadline ? new Date(t.deadline).getTime() : NO_DEADLINE;
    return pri * NO_DEADLINE - dl;
  };
  const cutoff = Date.now() - DONE_HIDE_MS;
  return [...tasks]
    .filter((t) => {
      if (t.status !== "done") return true;
      // Keep recently-done tasks visible for 18h so user sees the strikethrough
      const doneAt = t.completed_at ? new Date(t.completed_at).getTime() : 0;
      return doneAt > cutoff;
    })
    .sort((a, b) => {
      // Sort done tasks below active ones
      if (a.status === "done" && b.status !== "done") return 1;
      if (a.status !== "done" && b.status === "done") return -1;
      return score(b) - score(a);
    });
}

/** Done tasks completed today (for Agenda History / stat segment). */
export function doneTodayTasks(tasks: Task[]) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return tasks.filter(
    (t) => t.status === "done" && t.completed_at && new Date(t.completed_at) >= startOfDay
  );
}

/** AI-backed triage: calls /api/ai for real classification, heuristic fallback is server-side */
export async function triageSignalToTask(signal: {
  title: string;
  body?: string | null;
}): Promise<{ title: string; priority: TaskPriority; category: TaskCategory; effort: string; status: TaskStatus }> {
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "triage", text: signal.title, body: signal.body }),
    });
    if (res.ok) {
      const data = (await res.json()) as { title: string; priority: TaskPriority; category: TaskCategory; effort: string };
      return { ...data, status: "open" as TaskStatus };
    }
  } catch {
    // network error — fall through to heuristic
  }
  // local heuristic fallback
  const lower = `${signal.title} ${signal.body ?? ""}`.toLowerCase();
  let priority: TaskPriority = "med";
  if (/urgent|asap|high|critical|sign/.test(lower)) priority = "hi";
  if (/fyi|low|whenever/.test(lower)) priority = "lo";
  let category: TaskCategory = "research";
  if (/clinical|patient|bls|cert/.test(lower)) category = "clinical";
  if (/meal|tailor|personal|family/.test(lower)) category = "life";
  if (/personal|birthday/.test(lower)) category = "personal";
  let effort = "~1h";
  if (/quick|5 min|15 min/.test(lower)) effort = "~15m";
  if (/deep|2h|90/.test(lower)) effort = "~2h";
  return { title: signal.title, priority, category, effort, status: "open" as TaskStatus };
}
