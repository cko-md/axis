"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRealtimeRefresh } from "./useRealtimeRefresh";

export type BriefingSavedItem = {
  id: string;
  user_id: string;
  title: string;
  url: string;
  type: "read" | "watch";
  saved_at: string;
};

export type BriefingFeed = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  created_at: string;
};

// Legacy localStorage keys BriefingModule.tsx used before this hook existed.
// Read once for the one-time import below; left in place afterward since this
// hook doesn't own their full lifecycle.
const SAVED_LS_KEY = "axis-briefing-saved";
const FEEDS_LS_KEY = "axis-briefing-feeds";

type LegacySavedItem = { id: string; title: string; url: string; savedAt: string; type: "read" | "watch" };
type LegacyFeed = { name: string; url: string };

function readLegacySaved(): LegacySavedItem[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(SAVED_LS_KEY) ?? "[]"); } catch { return []; }
}
function readLegacyFeeds(): LegacyFeed[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(FEEDS_LS_KEY) ?? "[]"); } catch { return []; }
}

export function useBriefing() {
  const supabase = useMemo(() => createClient(), []);
  const [savedItems, setSavedItems] = useState<BriefingSavedItem[]>([]);
  const [feeds, setFeeds] = useState<BriefingFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);
    if (!user) {
      setSavedItems([]);
      setFeeds([]);
      setLoading(false);
      return;
    }

    const [savedRes, feedsRes] = await Promise.all([
      supabase.from("briefing_saved_items").select("*").eq("user_id", user.id),
      supabase.from("briefing_feeds").select("*").eq("user_id", user.id).order("created_at", { ascending: true }),
    ]);
    let savedRows = (savedRes.data ?? []) as BriefingSavedItem[];
    let feedRows = (feedsRes.data ?? []) as BriefingFeed[];

    // One-time import: only fires when the user has zero rows server-side (so
    // re-imports never duplicate or stomp real data) and the browser actually
    // has legacy data to bring across.
    if (savedRows.length === 0 && !savedRes.error) {
      const legacy = readLegacySaved().filter((s) => s.url);
      if (legacy.length > 0) {
        // Coerce `type` defensively — it's the one CHECK-constrained column,
        // and a single bad row would abort the entire batch insert, silently
        // dropping every other valid item along with it.
        const { data: inserted } = await supabase
          .from("briefing_saved_items")
          .insert(legacy.map((s) => ({
            user_id: user.id,
            title: s.title || s.url,
            url: s.url,
            type: s.type === "watch" ? "watch" : "read",
            saved_at: s.savedAt || new Date().toISOString(),
          })))
          .select();
        if (inserted?.length) savedRows = inserted as BriefingSavedItem[];
      }
    }
    if (feedRows.length === 0 && !feedsRes.error) {
      const legacy = readLegacyFeeds();
      if (legacy.length > 0) {
        const { data: inserted } = await supabase
          .from("briefing_feeds")
          .upsert(legacy.map((f) => ({ user_id: user.id, name: f.name, url: f.url })), { onConflict: "user_id,url" })
          .select();
        if (inserted?.length) feedRows = inserted as BriefingFeed[];
      }
    }

    setSavedItems(savedRows.sort((a, b) => new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime()));
    setFeeds(feedRows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useRealtimeRefresh(supabase, ["briefing_saved_items", "briefing_feeds"], userId, refresh);

  const addSavedItem = useCallback(async (item: { title: string; url: string; type: "read" | "watch" }) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from("briefing_saved_items")
        .insert({ user_id: user.id, title: item.title, url: item.url, type: item.type })
        .select()
        .single();
      if (error || !data) return null;
      setSavedItems((prev) => [data as BriefingSavedItem, ...prev]);
      return data as BriefingSavedItem;
    } catch (err) {
      console.error("[useBriefing] addSavedItem", err);
      return null;
    }
  }, [supabase]);

  const removeSavedItem = useCallback(async (url: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: "Sign in required." };
      const { error } = await supabase.from("briefing_saved_items").delete().eq("user_id", user.id).eq("url", url);
      if (error) return { error: error.message };
      setSavedItems((prev) => prev.filter((s) => s.url !== url));
      return {};
    } catch (err) {
      console.error("[useBriefing] removeSavedItem", err);
      return { error: "Failed to remove." };
    }
  }, [supabase]);

  const addFeed = useCallback(async (feed: { name: string; url: string }) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;
      const { data, error } = await supabase
        .from("briefing_feeds")
        .upsert({ user_id: user.id, name: feed.name, url: feed.url }, { onConflict: "user_id,url" })
        .select()
        .single();
      if (error || !data) return null;
      setFeeds((prev) => [...prev.filter((f) => f.url !== feed.url), data as BriefingFeed]);
      return data as BriefingFeed;
    } catch (err) {
      console.error("[useBriefing] addFeed", err);
      return null;
    }
  }, [supabase]);

  const removeFeed = useCallback(async (url: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { error: "Sign in required." };
      const { error } = await supabase.from("briefing_feeds").delete().eq("user_id", user.id).eq("url", url);
      if (error) return { error: error.message };
      setFeeds((prev) => prev.filter((f) => f.url !== url));
      return {};
    } catch (err) {
      console.error("[useBriefing] removeFeed", err);
      return { error: "Failed to remove." };
    }
  }, [supabase]);

  return { savedItems, feeds, loading, refresh, addSavedItem, removeSavedItem, addFeed, removeFeed };
}
