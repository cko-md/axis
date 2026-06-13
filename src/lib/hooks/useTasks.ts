"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
};

export function useTasks() {
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setTasks([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    const now = Date.now();
    const normalized = (data ?? []).map((t) => {
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

  const addTask = async (partial: Partial<Task> & { title: string; category: TaskCategory }) => {
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
  };

  const updateTask = async (id: string, patch: Partial<Task>) => {
    const { data, error } = await supabase.from("tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (!error && data) setTasks((prev) => prev.map((t) => (t.id === id ? (data as Task) : t)));
  };

  const deleteTask = async (id: string) => {
    await supabase.from("tasks").delete().eq("id", id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const toggleDone = async (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    await updateTask(id, { status: t.status === "done" ? "open" : "done" });
  };

  return { tasks, loading, refresh, addTask, updateTask, deleteTask, toggleDone };
}

export function rankTasks(tasks: Task[]) {
  // Far-future sentinel keeps no-deadline tasks finite so priority still breaks ties
  const NO_DEADLINE = Date.UTC(2100, 0, 1);
  const score = (t: Task) => {
    const pri = t.priority === "hi" ? 3 : t.priority === "med" ? 2 : 1;
    const dl = t.deadline ? new Date(t.deadline).getTime() : NO_DEADLINE;
    return pri * NO_DEADLINE - dl;
  };
  return [...tasks].filter((t) => t.status !== "done").sort((a, b) => score(b) - score(a));
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
