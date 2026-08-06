"use client";

import * as Sentry from "@sentry/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";
import type { Database, Json } from "@/lib/supabase/database.types";
import { deferFailureCommit } from "@/lib/observability/deferFailureCommit";

type TaskRowUpdate = Database["public"]["Tables"]["tasks"]["Update"];

export type TaskCategory = "research" | "clinical" | "life" | "personal";
export type TaskPriority = "hi" | "med" | "lo";
export type TaskStatus = "open" | "done" | "overdue";
export type TaskRankReason = {
  score: number;
  priorityWeight: number;
  deadlineLabel: string;
  stale: boolean;
  explanation: string;
};

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

export type TaskMutationError = {
  operation: "load" | "add" | "update" | "delete";
  message: string;
  code?: string;
};

type SupabaseLikeError = {
  code?: string;
  status?: number;
};

type TaskLoadOperation = {
  controller: AbortController;
  generation: number;
  identity: symbol;
};

function isMissingTaskSession(error: unknown) {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const value = error as Record<string, unknown>;
  const status = value.status;
  const boundedMissingSessionStatus =
    status === undefined || status === 400 || status === 401;
  return (
    status === 401 ||
    (value.name === "AuthSessionMissingError" && status === 400) ||
    (boundedMissingSessionStatus &&
      (value.code === "refresh_token_not_found" ||
        value.code === "invalid_refresh_token" ||
        value.message === "Auth session missing!"))
  );
}

export type TaskUpdate = Partial<Pick<
  Task,
  "title" | "priority" | "effort" | "deadline" | "category" | "status" | "sort_order" | "metadata" | "completed_at"
>>;

const DONE_HIDE_MS = 18 * 60 * 60 * 1000; // 18 hours
const STALE_OPEN_MS = 7 * 24 * 60 * 60 * 1000;

export function useTasks() {
  const supabase = useMemo(() => createClient(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [error, setError] = useState<TaskMutationError | null>(null);
  const mountedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const ownershipEpochRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const activeLoadRef = useRef<TaskLoadOperation | null>(null);
  const loadedOwnerRef = useRef<string | null>(null);
  const loadedOwnerAuthorityRef = useRef<"load" | "mutation" | null>(null);
  const accountChangeFeedbackRef = useRef<"add" | "update" | "delete" | null>(null);

  const recordError = useCallback((operation: TaskMutationError["operation"], rawError: unknown, message: string) => {
    const err = rawError as SupabaseLikeError | null;
    const next = { operation, message, code: err?.code };
    setError(next);
    Sentry.captureException(new Error(`Task ${operation} failed`), {
      tags: {
        area: "tasks",
        operation,
        supabase_code: err?.code ?? "unknown",
      },
      contexts: {
        supabase: {
          status: err?.status ?? null,
        },
      },
    });
    return next;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const isLoadCurrent = useCallback((operation: TaskLoadOperation) => {
    const active = activeLoadRef.current;
    return (
      mountedRef.current
      && pageActiveRef.current
      && !operation.controller.signal.aborted
      && active === operation
      && active.controller === operation.controller
      && active.identity === operation.identity
      && loadGenerationRef.current === operation.generation
    );
  }, []);

  const isMutationEpochCurrent = useCallback((ownershipEpoch: number) => (
    mountedRef.current
    && pageActiveRef.current
    && ownershipEpochRef.current === ownershipEpoch
  ), []);

  const isMutationCurrent = useCallback((
    ownershipEpoch: number,
    subject: string | null,
  ) => (
    isMutationEpochCurrent(ownershipEpoch)
    && loadedOwnerRef.current === subject
  ), [isMutationEpochCurrent]);

  const refresh = useCallback(async () => {
    const operation: TaskLoadOperation = {
      controller: new AbortController(),
      generation: ++loadGenerationRef.current,
      identity: Symbol("task-load"),
    };
    activeLoadRef.current?.controller.abort();
    activeLoadRef.current = operation;

    const commitSignedOut = () => {
      ownershipEpochRef.current += 1;
      const accountChangeOperation = accountChangeFeedbackRef.current;
      accountChangeFeedbackRef.current = null;
      loadedOwnerRef.current = null;
      loadedOwnerAuthorityRef.current = null;
      setUserId(null);
      setTasks([]);
      setError(accountChangeOperation ? {
        operation: accountChangeOperation,
        message: "Account changed — sign in to continue.",
      } : null);
      setLoading(false);
      activeLoadRef.current = null;
    };

    const commitFailure = async (rawError: unknown, message: string, clearRows = false) => {
      await deferFailureCommit();
      if (!isLoadCurrent(operation)) return;
      accountChangeFeedbackRef.current = null;
      recordError("load", rawError, message);
      if (clearRows) {
        ownershipEpochRef.current += 1;
        loadedOwnerRef.current = null;
        loadedOwnerAuthorityRef.current = null;
        setUserId(null);
        setTasks([]);
      }
      setLoading(false);
      activeLoadRef.current = null;
    };

    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (!isLoadCurrent(operation)) return;
      if (authError) {
        if (isMissingTaskSession(authError)) {
          commitSignedOut();
          return;
        }
        await commitFailure(authError, "Could not load tasks — sign in again and retry.", true);
        return;
      }
      if (!user) {
        commitSignedOut();
        return;
      }
      if (loadedOwnerRef.current !== user.id) {
        ownershipEpochRef.current += 1;
        if (loadedOwnerRef.current !== null) setTasks([]);
      }
      loadedOwnerRef.current = user.id;
      loadedOwnerAuthorityRef.current = "load";
      setUserId(user.id);

      const { data, error: loadError } = await supabase
        .from("tasks")
        .select("*")
        .eq("user_id", user.id)
        .order("sort_order", { ascending: true })
        .abortSignal(operation.controller.signal);
      if (!isLoadCurrent(operation)) return;
      if (loadError || !data) {
        await commitFailure(loadError, "Could not load tasks — check your connection and retry.");
        return;
      }
      const now = Date.now();
      const normalized = data.map((t) => {
        if (t.status === "open" && t.deadline && new Date(t.deadline).getTime() < now) {
          return { ...t, status: "overdue" as TaskStatus };
        }
        return t as Task;
      });
      if (!isLoadCurrent(operation)) return;
      setTasks(normalized as Task[]);
      const accountChangeOperation = accountChangeFeedbackRef.current;
      accountChangeFeedbackRef.current = null;
      if (accountChangeOperation) {
        setError({
          operation: accountChangeOperation,
          message: "Account changed — tasks reloaded for the current account. Retry your action.",
        });
      } else {
        clearError();
      }
      setLoading(false);
      activeLoadRef.current = null;
    } catch (loadError) {
      if (isMissingTaskSession(loadError) && isLoadCurrent(operation)) {
        commitSignedOut();
        return;
      }
      await commitFailure(loadError, "Could not load tasks — check your connection and retry.");
    }
  }, [clearError, isLoadCurrent, recordError, supabase]);

  useEffect(() => {
    mountedRef.current = true;
    pageActiveRef.current = true;
    const invalidate = () => {
      pageActiveRef.current = false;
      ownershipEpochRef.current += 1;
      loadGenerationRef.current += 1;
      activeLoadRef.current?.controller.abort();
      activeLoadRef.current = null;
      accountChangeFeedbackRef.current = null;
    };
    const restore = (event: PageTransitionEvent) => {
      const wasInactive = !pageActiveRef.current;
      pageActiveRef.current = true;
      if (!wasInactive) return;
      if (event.persisted) {
        loadedOwnerRef.current = null;
        loadedOwnerAuthorityRef.current = null;
        setUserId(null);
        setTasks([]);
        setLoading(true);
      }
      void refresh();
    };
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("pageshow", restore);
    return () => {
      mountedRef.current = false;
      invalidate();
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("pageshow", restore);
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "tasks", userId, refresh);

  const settleMutationSignedOut = useCallback((
    operation: "add" | "update" | "delete",
    message: string,
  ) => {
    ownershipEpochRef.current += 1;
    loadGenerationRef.current += 1;
    activeLoadRef.current?.controller.abort();
    activeLoadRef.current = null;
    accountChangeFeedbackRef.current = null;
    loadedOwnerRef.current = null;
    loadedOwnerAuthorityRef.current = null;
    setUserId(null);
    setTasks([]);
    setLoading(false);
    setError({ operation, message });
  }, []);

  const retireMutationOwnerClaim = useCallback((
    operation: "add" | "update" | "delete",
  ) => {
    ownershipEpochRef.current += 1;
    loadGenerationRef.current += 1;
    activeLoadRef.current?.controller.abort();
    activeLoadRef.current = null;
    accountChangeFeedbackRef.current = operation;
    loadedOwnerRef.current = null;
    loadedOwnerAuthorityRef.current = null;
    setUserId(null);
    setTasks([]);
    setLoading(true);
    setError({
      operation,
      message: "Account changed — reloading tasks for the current account.",
    });
    void refresh();
  }, [refresh]);

  const authenticateMutation = useCallback(async (
    ownershipEpoch: number,
    subjectAtStart: string | null,
    operation: "add" | "update" | "delete",
    signedOutMessage: string,
    failureMessage: string,
  ) => {
    if (
      accountChangeFeedbackRef.current !== null
      && activeLoadRef.current !== null
    ) {
      return null;
    }
    const settleSignedOut = () => {
      settleMutationSignedOut(operation, signedOutMessage);
      return null;
    };
    try {
      const { data: { user }, error: authError } =
        await supabase.auth.getUser();
      if (!isMutationEpochCurrent(ownershipEpoch)) return null;
      if (authError) {
        if (loadedOwnerRef.current !== subjectAtStart) {
          if (
            subjectAtStart === null
            && loadedOwnerAuthorityRef.current === "mutation"
          ) {
            if (isMissingTaskSession(authError)) {
              retireMutationOwnerClaim(operation);
            } else {
              recordError(operation, authError, failureMessage);
            }
          }
          return null;
        }
        if (isMissingTaskSession(authError)) return settleSignedOut();
        recordError(operation, authError, failureMessage);
        return null;
      }
      if (!user) {
        if (loadedOwnerRef.current !== subjectAtStart) {
          if (
            subjectAtStart === null
            && loadedOwnerAuthorityRef.current === "mutation"
          ) {
            retireMutationOwnerClaim(operation);
          }
          return null;
        }
        return settleSignedOut();
      }
      const currentOwner = loadedOwnerRef.current;
      if (subjectAtStart === null) {
        if (currentOwner === null) {
          loadedOwnerRef.current = user.id;
          loadedOwnerAuthorityRef.current = "mutation";
          setUserId(user.id);
        } else if (currentOwner !== user.id) {
          if (loadedOwnerAuthorityRef.current === "mutation") {
            retireMutationOwnerClaim(operation);
          }
          return null;
        }
      } else {
        if (currentOwner !== subjectAtStart) return null;
        if (user.id !== subjectAtStart) {
          retireMutationOwnerClaim(operation);
          return null;
        }
      }
      if (!isMutationCurrent(ownershipEpoch, user.id)) return null;
      return user;
    } catch (authError) {
      if (!isMutationEpochCurrent(ownershipEpoch)) return null;
      if (loadedOwnerRef.current !== subjectAtStart) {
        if (
          subjectAtStart === null
          && loadedOwnerAuthorityRef.current === "mutation"
        ) {
          if (isMissingTaskSession(authError)) {
            retireMutationOwnerClaim(operation);
          } else {
            recordError(operation, authError, failureMessage);
          }
        }
        return null;
      }
      if (isMissingTaskSession(authError)) return settleSignedOut();
      recordError(operation, authError, failureMessage);
      return null;
    }
  }, [isMutationCurrent, isMutationEpochCurrent, recordError, retireMutationOwnerClaim, settleMutationSignedOut, supabase]);

  const addTask = useCallback(async (partial: Partial<Task> & { title: string; category: TaskCategory }) => {
    const ownershipEpoch = ownershipEpochRef.current;
    const subjectAtStart = loadedOwnerRef.current;
    const user = await authenticateMutation(
      ownershipEpoch,
      subjectAtStart,
      "add",
      "Sign in to create tasks.",
      "Could not create task — sign in again and retry.",
    );
    if (!user) return null;
    let data: unknown;
    let error: unknown;
    try {
      const result = await supabase
        .from("tasks")
        .insert({
          user_id: user.id,
          title: partial.title,
          category: partial.category,
          priority: partial.priority ?? "med",
          effort: partial.effort ?? null,
          deadline: partial.deadline ?? null,
          metadata: (partial.metadata ?? {}) as Json,
          status: "open",
          sort_order: tasks.length,
        })
        .select()
        .single();
      if (!isMutationCurrent(ownershipEpoch, user.id)) return null;
      data = result.data;
      error = result.error;
    } catch (mutationError) {
      if (!isMutationCurrent(ownershipEpoch, user.id)) return null;
      if (isMissingTaskSession(mutationError)) {
        settleMutationSignedOut("add", "Sign in to create tasks.");
        return null;
      }
      recordError("add", mutationError, "Could not create task — check your connection and retry.");
      return null;
    }
    if (!error && data) {
      setTasks((prev) => [...prev, data as Task]);
      clearError();
      return data as Task;
    }
    if (isMissingTaskSession(error)) {
      settleMutationSignedOut("add", "Sign in to create tasks.");
      return null;
    }
    recordError("add", error, "Could not create task — check your connection and retry.");
    return null;
  }, [authenticateMutation, clearError, isMutationCurrent, recordError, settleMutationSignedOut, supabase, tasks.length]);

  const updateTask = useCallback(async (id: string, patch: TaskUpdate) => {
    const ownershipEpoch = ownershipEpochRef.current;
    const subjectAtStart = loadedOwnerRef.current;
    const user = await authenticateMutation(
      ownershipEpoch,
      subjectAtStart,
      "update",
      "Sign in to update tasks.",
      "Could not update task — sign in again and retry.",
    );
    if (!user) return null;
    let data: unknown;
    let error: unknown;
    try {
      const result = await supabase.from("tasks").update({ ...patch, updated_at: new Date().toISOString() } as TaskRowUpdate).eq("id", id).select().single();
      if (!isMutationCurrent(ownershipEpoch, user.id)) return null;
      data = result.data;
      error = result.error;
    } catch (mutationError) {
      if (!isMutationCurrent(ownershipEpoch, user.id)) return null;
      if (isMissingTaskSession(mutationError)) {
        settleMutationSignedOut("update", "Sign in to update tasks.");
        return null;
      }
      recordError("update", mutationError, "Could not update task — check your connection and retry.");
      return null;
    }
    if (!error && data) {
      setTasks((prev) => prev.map((t) => (t.id === id ? (data as Task) : t)));
      clearError();
      return data as Task;
    }
    if (isMissingTaskSession(error)) {
      settleMutationSignedOut("update", "Sign in to update tasks.");
      return null;
    }
    recordError("update", error, "Could not update task — check your connection and retry.");
    return null;
  }, [authenticateMutation, clearError, isMutationCurrent, recordError, settleMutationSignedOut, supabase]);

  const deleteTask = useCallback(async (id: string) => {
    const ownershipEpoch = ownershipEpochRef.current;
    const subjectAtStart = loadedOwnerRef.current;
    const user = await authenticateMutation(
      ownershipEpoch,
      subjectAtStart,
      "delete",
      "Sign in to delete tasks.",
      "Could not delete task — sign in again and retry.",
    );
    if (!user) return false;
    let error: unknown;
    try {
      ({ error } = await supabase.from("tasks").delete().eq("id", id));
      if (!isMutationCurrent(ownershipEpoch, user.id)) return false;
    } catch (mutationError) {
      if (!isMutationCurrent(ownershipEpoch, user.id)) return false;
      if (isMissingTaskSession(mutationError)) {
        settleMutationSignedOut("delete", "Sign in to delete tasks.");
        return false;
      }
      recordError("delete", mutationError, "Could not delete task — check your connection and retry.");
      return false;
    }
    if (!error) {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      clearError();
      return true;
    }
    if (isMissingTaskSession(error)) {
      settleMutationSignedOut("delete", "Sign in to delete tasks.");
      return false;
    }
    recordError("delete", error, "Could not delete task — check your connection and retry.");
    return false;
  }, [authenticateMutation, clearError, isMutationCurrent, recordError, settleMutationSignedOut, supabase]);

  const toggleDone = useCallback(async (id: string) => {
    const ownershipEpoch = ownershipEpochRef.current;
    const subjectAtStart = loadedOwnerRef.current;
    if (!isMutationCurrent(ownershipEpoch, subjectAtStart)) return null;
    const t = tasks.find((x) => x.id === id);
    if (!t) return null;
    const isDone = t.status === "done";
    const updated = await updateTask(id, {
      status: isDone ? "open" : "done",
      completed_at: isDone ? null : new Date().toISOString(),
    });
    return isMutationCurrent(ownershipEpoch, subjectAtStart) ? updated : null;
  }, [isMutationCurrent, tasks, updateTask]);

  return { tasks, loading, error, clearError, refresh, addTask, updateTask, deleteTask, toggleDone };
}

export function rankTasks(tasks: Task[]) {
  const NO_DEADLINE = Date.UTC(2100, 0, 1);
  const score = (t: Task) => {
    const pri = taskPriorityWeight(t);
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

export function taskPriorityWeight(task: Task) {
  if (task.priority === "hi") return 3;
  if (task.priority === "med") return 2;
  return 1;
}

export function isTaskOverdue(task: Task, now = Date.now()) {
  return task.status !== "done" && !!task.deadline && new Date(task.deadline).getTime() < now;
}

export function isTaskStale(task: Task, now = Date.now()) {
  if (task.status === "done") return false;
  const updated = new Date(task.updated_at ?? task.created_at).getTime();
  return Number.isFinite(updated) && now - updated > STALE_OPEN_MS;
}

export function taskRankReason(task: Task, now = Date.now()): TaskRankReason {
  const priorityWeight = taskPriorityWeight(task);
  const deadlineMs = task.deadline ? new Date(task.deadline).getTime() : null;
  const overdue = isTaskOverdue(task, now);
  const stale = isTaskStale(task, now);
  const deadlineLabel = !deadlineMs
    ? "No deadline"
    : overdue
      ? "Past due"
      : `Due ${new Date(deadlineMs).toLocaleDateString()}`;
  const score = priorityWeight * 100 + (deadlineMs ? Math.max(0, Math.ceil((deadlineMs - now) / 86_400_000)) * -1 : 0) + (stale ? -10 : 0);
  const parts = [
    `${task.priority.toUpperCase()} priority`,
    deadlineLabel.toLowerCase(),
    stale ? "stale open loop" : "recently touched",
  ];
  return {
    score,
    priorityWeight,
    deadlineLabel,
    stale,
    explanation: parts.join(" · "),
  };
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
