"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Server-synced per-user setting backed by the generic `user_settings` table
 * (one row per (user, key), jsonb value) with a localStorage mirror as the
 * fast path. This is what moves a preference from "resets on every new
 * device/login" to "follows the account".
 *
 * Semantics, in order:
 *  1. First paint reads the LS mirror (or `fallback`) — no flash, works
 *     signed-out.
 *  2. After auth resolves, the server row wins over the mirror.
 *  3. If the server has NO row, `legacyLocalKeys` are scanned once and the
 *     first hit is imported and saved — the same one-time-import guard the
 *     briefing/atelier migrations used (import only into an empty server
 *     state, so a second device never stomps real data).
 *  4. Writes update state + mirror immediately and upsert after a short
 *     debounce. An edit epoch guards against a slow load overwriting a
 *     fresher edit (same hazard ThemeProvider handles).
 *
 * Transient save errors surface as status "error" but do NOT flip the hook
 * into a permanent local-only mode — the next write retries. (Several older
 * hooks latch local-only on the first error; that pattern silently loses
 * data for the rest of the session and is deliberately not copied.)
 */

export type SyncedSettingStatus = "loading" | "local" | "synced" | "error";

type SyncedSettingOptions<T> = {
  /** user_settings.key — dot-namespaced, e.g. "nav.customization". */
  key: string;
  /** Value used when nothing is stored anywhere yet. */
  fallback: T;
  /**
   * Pre-existing localStorage keys to import when the server has no row.
   * Scanned in order; first parseable hit wins.
   */
  legacyLocalKeys?: readonly string[];
  /** Parse a legacy raw string. Defaults to JSON.parse. Return null to skip. */
  parseLegacy?: (raw: string, legacyKey: string) => T | null;
  /** Optional guard for values coming back from the server. */
  validate?: (value: unknown) => value is T;
};

const SAVE_DEBOUNCE_MS = 450;

function mirrorKey(key: string): string {
  return `axis.setting.${key}`;
}

function readMirror<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(mirrorKey(key));
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function useSyncedSetting<T>(options: SyncedSettingOptions<T>) {
  const { key, fallback, legacyLocalKeys, parseLegacy, validate } = options;
  const supabase = useMemo(() => createClient(), []);
  const [value, setValueState] = useState<T>(() => readMirror(key, fallback, validate));
  const [status, setStatus] = useState<SyncedSettingStatus>("loading");

  const editEpochRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;

  const persistToServer = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setStatus("local");
        return;
      }
      const { error } = await supabase.from("user_settings").upsert(
        {
          user_id: user.id,
          key,
          value: latestValueRef.current as never,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,key" },
      );
      setStatus(error ? "error" : "synced");
    }, SAVE_DEBOUNCE_MS);
  }, [key, supabase]);

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      editEpochRef.current += 1;
      setValueState((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(mirrorKey(key), JSON.stringify(resolved));
        } catch {
          // Mirror is best-effort; the server write below is what matters.
        }
        latestValueRef.current = resolved;
        return resolved;
      });
      persistToServer();
    },
    [key, persistToServer],
  );

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const epochAtLoad = editEpochRef.current;

    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        setStatus("local");
        return;
      }

      const { data, error } = await supabase
        .from("user_settings")
        .select("value")
        .eq("user_id", user.id)
        .eq("key", key)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setStatus("error");
        return;
      }

      if (data) {
        const serverValue = data.value as unknown;
        if (!validate || validate(serverValue)) {
          // Only apply if the user hasn't edited while the load was in flight.
          if (editEpochRef.current === epochAtLoad) {
            setValueState(serverValue as T);
            latestValueRef.current = serverValue as T;
            try {
              localStorage.setItem(mirrorKey(key), JSON.stringify(serverValue));
            } catch { /* best effort */ }
          }
        }
        setStatus("synced");
        return;
      }

      // No server row: one-time import from the feature's legacy LS keys.
      for (const legacyKey of legacyLocalKeys ?? []) {
        let imported: T | null = null;
        try {
          const raw = localStorage.getItem(legacyKey);
          if (raw === null) continue;
          imported = parseLegacy
            ? parseLegacy(raw, legacyKey)
            : (JSON.parse(raw) as T);
        } catch {
          continue;
        }
        if (imported === null) continue;
        if (validate && !validate(imported)) continue;
        if (editEpochRef.current === epochAtLoad) {
          setValueState(imported);
          latestValueRef.current = imported;
          try {
            localStorage.setItem(mirrorKey(key), JSON.stringify(imported));
          } catch { /* best effort */ }
        }
        const { error: importError } = await supabase.from("user_settings").upsert(
          {
            user_id: user.id,
            key,
            value: (editEpochRef.current === epochAtLoad ? imported : latestValueRef.current) as never,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,key" },
        );
        if (!cancelled) setStatus(importError ? "error" : "synced");
        return;
      }

      if (!cancelled) setStatus("synced");
    })();

    return () => {
      cancelled = true;
    };
    // parseLegacy/validate/legacyLocalKeys are expected to be stable module-level
    // values; key is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supabase]);

  return [value, setValue, status] as const;
}
