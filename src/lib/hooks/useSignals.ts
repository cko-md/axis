"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type SignalType = "action" | "awaiting" | "fyi";

/** Shape of AI triage details we persist into signals.metadata (no schema change needed). */
export type SignalAIMeta = {
  ai_destination?: string;
  ai_priority?: "hi" | "med" | "lo";
  ai_reason?: string;
  ai_confidence?: number;
  ai_at?: string;
  routed_via?: "ai" | "manual" | "rule";
  routed_task_id?: string;
  routed_task_title?: string;
  routed_note_id?: string;
  routed_note_title?: string;
  archived_at?: string;
  dismissed_at?: string;
  snoozed_until?: string;
  source_object_type?: string;
  source_object_id?: string;
  source_route?: string;
  source_url?: string;
};

export type Signal = {
  id: string;
  user_id: string;
  title: string;
  body: string | null;
  source: string;
  signal_type: SignalType;
  route_target: string | null;
  read_at: string | null;
  routed_at: string | null;
  metadata: Record<string, unknown> & SignalAIMeta;
  created_at: string;
  updated_at: string;
};

/** Result returned by the /api/signals-ai route. */
export type SignalClassification = {
  id?: string;
  signal_type: SignalType;
  priority: "hi" | "med" | "lo";
  destination: string;
  reason: string;
  confidence: number;
};

/** Classify a single signal via the dedicated AI route (heuristic fallback is server-side). */
export async function classifySignal(s: Pick<Signal, "id" | "title" | "body" | "source">): Promise<SignalClassification> {
  try {
    const res = await fetch("/api/signals-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, title: s.title, body: s.body, source: s.source }),
    });
    if (res.ok) return (await res.json()) as SignalClassification;
  } catch {
    /* fall through */
  }
  return { id: s.id, signal_type: "action", priority: "med", destination: "agenda", reason: "Offline default", confidence: 0.3 };
}

/** Classify many signals in one round-trip. */
export async function classifySignals(
  list: Pick<Signal, "id" | "title" | "body" | "source">[],
): Promise<SignalClassification[]> {
  if (list.length === 0) return [];
  try {
    const res = await fetch("/api/signals-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "batch",
        signals: list.map((s) => ({ id: s.id, title: s.title, body: s.body, source: s.source })),
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { results: SignalClassification[] };
      return data.results ?? [];
    }
  } catch {
    /* fall through */
  }
  return Promise.all(list.map((s) => classifySignal(s)));
}

const SEED: Omit<Signal, "id" | "user_id" | "created_at" | "updated_at">[] = [
  { title: "IRB amendment — signature requested", body: "Dr. Adeyemi needs sign-off by EOD", source: "Mail", signal_type: "action", route_target: "agenda", read_at: null, routed_at: null, metadata: {} },
  { title: "Fine–Gray code review returned", body: "Riku left comments on PR #42", source: "GitHub", signal_type: "awaiting", route_target: "pipeline", read_at: null, routed_at: null, metadata: {} },
  { title: "Polygon: portfolio digest ready", body: "Daily P&L summary", source: "AI digest", signal_type: "fyi", route_target: "fund", read_at: null, routed_at: null, metadata: {} },
  { title: "Conference travel — AANS booking window", body: "Book before Friday", source: "Calendar", signal_type: "action", route_target: "schedule", read_at: null, routed_at: null, metadata: {} },
];

export function useSignals() {
  const supabase = useMemo(() => createClient(), []);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setSignals([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase.from("signals").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    if (!data?.length) {
      const inserts = SEED.map((s) => ({ ...s, user_id: user.id }));
      const { data: seeded } = await supabase.from("signals").insert(inserts).select();
      setSignals((seeded ?? []) as Signal[]);
    } else {
      setSignals(data as Signal[]);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, "signals", userId, refresh);

  const capture = useCallback(async (title: string, type: SignalType = "action", source = "capture") => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("signals")
      .insert({ user_id: user.id, title, signal_type: type, source, body: null })
      .select()
      .single();
    if (data) {
      setSignals((prev) => [data as Signal, ...prev]);
      return data as Signal;
    }
    return null;
  }, [supabase]);

  const updateSignal = useCallback(async (id: string, patch: Partial<Signal>) => {
    const { data, error } = await supabase.from("signals").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
    if (error || !data) return null;
    setSignals((prev) => prev.map((s) => (s.id === id ? (data as Signal) : s)));
    return data as Signal;
  }, [supabase]);

  const markRead = useCallback((id: string) => updateSignal(id, { read_at: new Date().toISOString() }), [updateSignal]);

  const routeTo = useCallback((id: string, target: string, via: SignalAIMeta["routed_via"] = "manual", metadataPatch: Record<string, unknown> = {}) => {
    const current = signals.find((s) => s.id === id);
    return updateSignal(id, {
      route_target: target,
      routed_at: new Date().toISOString(),
      read_at: current?.read_at ?? new Date().toISOString(),
      metadata: { ...(current?.metadata ?? {}), routed_via: via, ...metadataPatch },
    });
  }, [signals, updateSignal]);

  /** Persist an AI classification onto a signal (reclassifies type + stores suggestion in metadata). */
  const applyClassification = useCallback((id: string, c: SignalClassification) => {
    const current = signals.find((s) => s.id === id);
    return updateSignal(id, {
      signal_type: c.signal_type,
      metadata: {
        ...(current?.metadata ?? {}),
        ai_destination: c.destination,
        ai_priority: c.priority,
        ai_reason: c.reason,
        ai_confidence: c.confidence,
        ai_at: new Date().toISOString(),
      },
    });
  }, [signals, updateSignal]);

  const deleteSignal = useCallback(async (id: string) => {
    const { error } = await supabase.from("signals").delete().eq("id", id);
    if (!error) setSignals((prev) => prev.filter((s) => s.id !== id));
  }, [supabase]);

  return { signals, loading, refresh, capture, updateSignal, deleteSignal, markRead, routeTo, applyClassification };
}

export function filterSignals(signals: Signal[], chip: string) {
  if (chip === "All") return signals;
  if (chip === "Routed by AI") return signals.filter((s) => s.routed_at);
  const map: Record<string, SignalType> = { Action: "action", Awaiting: "awaiting", FYI: "fyi" };
  const type = map[chip];
  return type ? signals.filter((s) => s.signal_type === type) : signals;
}

export function signalArchivedAt(signal: Signal): string | null {
  return typeof signal.metadata?.archived_at === "string" ? signal.metadata.archived_at : null;
}

export function signalDismissedAt(signal: Signal): string | null {
  return typeof signal.metadata?.dismissed_at === "string" ? signal.metadata.dismissed_at : null;
}

export function signalSnoozedUntil(signal: Signal): string | null {
  return typeof signal.metadata?.snoozed_until === "string" ? signal.metadata.snoozed_until : null;
}

export function isSignalArchived(signal: Signal): boolean {
  return Boolean(signalArchivedAt(signal));
}

export function isSignalSnoozed(signal: Signal, now = Date.now()): boolean {
  const until = signalSnoozedUntil(signal);
  return Boolean(until && new Date(until).getTime() > now);
}

export function isSignalVisible(signal: Signal, now = Date.now()): boolean {
  return !isSignalArchived(signal) && !isSignalSnoozed(signal, now);
}

export function isSignalActionable(signal: Signal, now = Date.now()): boolean {
  return signal.signal_type === "action" && !signal.routed_at && isSignalVisible(signal, now);
}
