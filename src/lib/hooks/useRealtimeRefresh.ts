"use client";

import { useEffect, useRef } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Subscribes to Postgres Realtime changes on one or more tables, scoped to
 * `userId`, calling `onChange` (typically a hook's own refetch function)
 * whenever a row changes — including from another device or tab signed into
 * the same account. No-op until userId is available; cleans up its channel
 * on unmount or when the table list / userId changes.
 */
export function useRealtimeRefresh(
  supabase: SupabaseClient,
  tables: string | string[],
  userId: string | null | undefined,
  onChange: () => void,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const tableList = Array.isArray(tables) ? tables : [tables];
  const key = tableList.join(",");

  useEffect(() => {
    if (!userId) return;
    const channel = supabase.channel(
      `realtime:${key}:${userId}:${crypto.randomUUID()}`,
    );
    for (const table of tableList) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` },
        () => onChangeRef.current(),
      );
    }
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, key, userId]);
}
