"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Signal } from "./useSignals";

export type RouteDestination =
  | "agenda"
  | "schedule"
  | "notes"
  | "pipeline"
  | "fund"
  | "literature"
  | "library"
  | "people";

export type RoutePriority = "keep" | "hi" | "med" | "lo";

export type SignalRoute = {
  id: string;
  user_id: string;
  label: string;
  destination: RouteDestination;
  match_keyword: string | null;
  match_type: "action" | "awaiting" | "fyi" | null;
  match_source: string | null;
  set_priority: RoutePriority;
  auto_route: boolean;
  enabled: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const DESTINATIONS: { id: RouteDestination; label: string }[] = [
  { id: "agenda", label: "Agenda" },
  { id: "schedule", label: "Schedule" },
  { id: "notes", label: "Notes" },
  { id: "pipeline", label: "Pipeline" },
  { id: "fund", label: "Fund" },
  { id: "literature", label: "Literature" },
  { id: "library", label: "Library" },
  { id: "people", label: "People" },
];

export type RouteInput = {
  label: string;
  destination: RouteDestination;
  match_keyword?: string | null;
  match_type?: "action" | "awaiting" | "fyi" | null;
  match_source?: string | null;
  set_priority?: RoutePriority;
  auto_route?: boolean;
  enabled?: boolean;
};

/** Does this signal match a route rule? A rule needs at least one matcher to apply. */
export function routeMatches(route: SignalRoute, signal: Pick<Signal, "title" | "body" | "signal_type" | "source">) {
  if (!route.enabled) return false;
  const hasMatcher = !!(route.match_keyword || route.match_type || route.match_source);
  if (!hasMatcher) return false;

  if (route.match_keyword) {
    const hay = `${signal.title} ${signal.body ?? ""}`.toLowerCase();
    if (!hay.includes(route.match_keyword.toLowerCase())) return false;
  }
  if (route.match_type && signal.signal_type !== route.match_type) return false;
  if (route.match_source && (signal.source ?? "").toLowerCase() !== route.match_source.toLowerCase()) return false;
  return true;
}

/** First enabled route whose matchers all match the signal. */
export function findMatchingRoute(
  routes: SignalRoute[],
  signal: Pick<Signal, "title" | "body" | "signal_type" | "source">,
): SignalRoute | null {
  return [...routes].sort((a, b) => a.sort_order - b.sort_order).find((r) => routeMatches(r, signal)) ?? null;
}

export function useSignalRoutes() {
  const supabase = useMemo(() => createClient(), []);
  const [routes, setRoutes] = useState<SignalRoute[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setRoutes([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("signal_routes")
      .select("*")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true });
    setRoutes((data ?? []) as SignalRoute[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addRoute = useCallback(async (input: RouteInput) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = await supabase
      .from("signal_routes")
      .insert({
        user_id: user.id,
        label: input.label,
        destination: input.destination,
        match_keyword: input.match_keyword?.trim() || null,
        match_type: input.match_type ?? null,
        match_source: input.match_source?.trim() || null,
        set_priority: input.set_priority ?? "keep",
        auto_route: input.auto_route ?? false,
        enabled: input.enabled ?? true,
        sort_order: routes.length,
      })
      .select()
      .single();
    if (!error && data) {
      setRoutes((prev) => [...prev, data as SignalRoute]);
      return data as SignalRoute;
    }
    return null;
  }, [supabase, routes.length]);

  const updateRoute = useCallback(async (id: string, patch: Partial<RouteInput>) => {
    const { data, error } = await supabase
      .from("signal_routes")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (!error && data) setRoutes((prev) => prev.map((r) => (r.id === id ? (data as SignalRoute) : r)));
  }, [supabase]);

  const deleteRoute = useCallback(async (id: string) => {
    await supabase.from("signal_routes").delete().eq("id", id);
    setRoutes((prev) => prev.filter((r) => r.id !== id));
  }, [supabase]);

  return { routes, loading, refresh, addRoute, updateRoute, deleteRoute };
}
