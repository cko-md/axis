"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

// Legacy localStorage key AtelierModule.tsx used before this hook existed.
// Read once for the one-time import below; left in place afterward since this
// hook doesn't own its full lifecycle.
const PINS_LS_KEY = "axis-atelier-pins";

function readLegacyPins(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(PINS_LS_KEY) ?? "null") ?? {}; } catch { return {}; }
}

/**
 * Per-user pinned-resource prefs for Atelier (atelier_prefs.pins jsonb, a
 * single row keyed by user_id). One-time import from the legacy localStorage
 * key when no row exists yet, falling back to the caller's seeded defaults.
 */
export function useAtelierPrefs(defaultPins: Record<string, boolean>) {
  const supabase = useMemo(() => createClient(), []);
  const userId = useRef<string | null>(null);
  const [pins, setPins] = useState<Record<string, boolean>>(defaultPins);
  const [loading, setLoading] = useState(true);
  const [subscribedUserId, setSubscribedUserId] = useState<string | null>(null);

  const loadPins = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }
    userId.current = user.id;
    setSubscribedUserId(user.id);
    {
      const { data, error } = await supabase
        .from("atelier_prefs")
        .select("pins")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!error && data) {
        setPins(data.pins as Record<string, boolean>);
        setLoading(false);
        return;
      }

      // No row yet — one-time import from legacy localStorage (merged over the
      // seeded defaults), then create the row.
      const legacy = readLegacyPins();
      const seeded = Object.keys(legacy).length > 0 ? { ...defaultPins, ...legacy } : defaultPins;
      const { data: inserted } = await supabase
        .from("atelier_prefs")
        .upsert({ user_id: user.id, pins: seeded })
        .select("pins")
        .maybeSingle();
      setPins((inserted?.pins as Record<string, boolean>) ?? seeded);
      setLoading(false);
    }
  }, [supabase, defaultPins]);

  useEffect(() => {
    void loadPins();
  }, [loadPins]);

  useRealtimeRefresh(supabase, "atelier_prefs", subscribedUserId, loadPins);

  const togglePin = useCallback((key: string) => {
    setPins((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (userId.current) {
        void supabase.from("atelier_prefs").upsert({ user_id: userId.current, pins: next, updated_at: new Date().toISOString() });
      }
      return next;
    });
  }, [supabase]);

  return { pins, loading, togglePin };
}
