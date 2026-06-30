"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Article = {
  id: string;
  title: string;
  authors: string;
  source: string;
  summary: string;
  url: string;
  publishedAt: string;
};

export type FeedSource = { name: string; ok: boolean; count: number };

export type FeedState = {
  articles: Article[];
  sources: FeedSource[];
  query: string;
  fetchedAt: string | null;
  fallback: boolean;
};

export type LiteraturePersistence = {
  mode: "supabase" | "local" | "unknown";
  warning: string | null;
};

export const DEFAULT_TOPICS: { key: string; label: string }[] = [
  { key: "neuroscience", label: "Neuroscience" },
  { key: "dbs", label: "DBS / Functional" },
  { key: "connectomics", label: "Connectomics" },
  { key: "neurooncology", label: "Neuro-Oncology" },
  { key: "methods", label: "Methods / Stats" },
];

// Re-exported alias so existing imports keep working
export const TOPICS = DEFAULT_TOPICS;

const BUILT_IN_KEYS = new Set(DEFAULT_TOPICS.map((t) => t.key));
const LS_KEY         = "axis.literature.topics";
const LS_CUSTOM_KEY  = "axis.literature.custom_topics";
const REFRESH_MS     = 4 * 60 * 1000;

function readLocalTopics(customKeys: Set<string>): string[] {
  if (typeof window === "undefined") return ["neuroscience"];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return ["neuroscience"];
    const allValid = new Set([...BUILT_IN_KEYS, ...customKeys]);
    const arr = (JSON.parse(raw) as string[]).filter((t) => allValid.has(t));
    return arr.length ? arr : ["neuroscience"];
  } catch {
    return ["neuroscience"];
  }
}

function readCustomTopics(): { key: string; label: string }[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(LS_CUSTOM_KEY) ?? "[]") as { key: string; label: string }[];
  } catch { return []; }
}

function writeCustomTopics(custom: { key: string; label: string }[]) {
  try { window.localStorage.setItem(LS_CUSTOM_KEY, JSON.stringify(custom)); } catch {}
}

function writeLocalTopics(topics: string[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(topics));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function useLiterature() {
  const [customTopics, setCustomTopicsState] = useState<{ key: string; label: string }[]>([]);
  const [topics, setTopicsState] = useState<string[]>(["neuroscience"]);
  const [query, setQuery] = useState<string>("");
  const [feed, setFeed] = useState<FeedState>({
    articles: [],
    sources: [],
    query: "",
    fetchedAt: null,
    fallback: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [persistence, setPersistence] = useState<LiteraturePersistence>({
    mode: "unknown",
    warning: null,
  });

  const supabase = useRef(createClient());
  const userId = useRef<string | null>(null);
  const prefsTable = useRef(true); // flips false if the table is missing — falls back to localStorage

  // ── Load custom topics from localStorage on mount
  useEffect(() => {
    const custom = readCustomTopics();
    setCustomTopicsState(custom);
  }, []);

  // ── Load persisted topic selection: Supabase for signed-in users, else localStorage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const customKeys = new Set(readCustomTopics().map((t) => t.key));
      const local = readLocalTopics(customKeys);
      if (!cancelled) setTopicsState(local);
      try {
        const { data: auth } = await supabase.current.auth.getUser();
        const uid = auth.user?.id ?? null;
        userId.current = uid;
        if (!uid) {
          setPersistence({
            mode: "local",
            warning: "Topic preferences are stored on this device while signed out.",
          });
          return;
        }
        const { data, error: e } = await supabase.current
          .from("literature_prefs")
          .select("topics,last_query")
          .eq("user_id", uid)
          .maybeSingle();
        if (e) {
          prefsTable.current = false;
          setPersistence({
            mode: "local",
            warning: "Topic preferences could not reach Supabase, so this beta module is using device-local settings.",
          });
          return;
        }
        setPersistence({ mode: "supabase", warning: null });
        if (!cancelled && data?.topics?.length) {
          const allKeys = new Set([...BUILT_IN_KEYS, ...readCustomTopics().map((t) => t.key)]);
          const valid = (data.topics as string[]).filter((t) => allKeys.has(t));
          if (valid.length) {
            setTopicsState(valid);
            writeLocalTopics(valid);
          }
        }
        if (!cancelled && typeof data?.last_query === "string") setQuery(data.last_query);
      } catch {
        prefsTable.current = false;
        setPersistence({
          mode: "local",
          warning: "Topic preferences could not reach Supabase, so this beta module is using device-local settings.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistTopics = useCallback((next: string[]) => {
    writeLocalTopics(next);
    const uid = userId.current;
    if (uid && prefsTable.current) {
      void supabase.current
        .from("literature_prefs")
        .upsert({ user_id: uid, topics: next, updated_at: new Date().toISOString() })
        .then(({ error: e }) => {
          if (e) {
            prefsTable.current = false;
            setPersistence({
              mode: "local",
              warning: "Topic preference changes did not save to Supabase and are device-local for now.",
            });
          } else {
            setPersistence({ mode: "supabase", warning: null });
          }
        });
    }
  }, []);

  const setTopics = useCallback(
    (next: string[]) => {
      const allKeys = new Set([...BUILT_IN_KEYS, ...customTopics.map((t) => t.key)]);
      const cleaned = next.filter((t) => allKeys.has(t));
      const final = cleaned.length ? cleaned : ["neuroscience"];
      setTopicsState(final);
      persistTopics(final);
    },
    [persistTopics, customTopics],
  );

  const addCustomTopic = useCallback((label: string) => {
    const key = label.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!key || BUILT_IN_KEYS.has(key)) return;
    setCustomTopicsState((prev) => {
      if (prev.some((t) => t.key === key)) return prev;
      const next = [...prev, { key, label: label.trim() }];
      writeCustomTopics(next);
      return next;
    });
    setTopicsState((prev) => {
      const next = [...prev, key];
      persistTopics(next);
      return next;
    });
  }, [persistTopics]);

  const removeCustomTopic = useCallback((key: string) => {
    setCustomTopicsState((prev) => {
      const next = prev.filter((t) => t.key !== key);
      writeCustomTopics(next);
      return next;
    });
    setTopicsState((prev) => {
      const next = prev.filter((t) => t !== key);
      const final = next.length ? next : ["neuroscience"];
      persistTopics(final);
      return final;
    });
  }, [persistTopics]);

  const toggleTopic = useCallback(
    (key: string) => {
      setTopicsState((prev) => {
        const has = prev.includes(key);
        const next = has ? prev.filter((t) => t !== key) : [...prev, key];
        const final = next.length ? next : ["neuroscience"];
        persistTopics(final);
        return final;
      });
    },
    [persistTopics],
  );

  // ── Fetch the feed for the current topics / query.
  const fetchFeed = useCallback(
    async (opts?: { silent?: boolean; nocache?: boolean; queryOverride?: string }) => {
      if (!opts?.silent) setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams();
        const activeQuery = opts?.queryOverride ?? query;
        if (activeQuery.trim()) params.set("q", activeQuery.trim());
        else params.set("topic", topics.join(","));
        if (opts?.nocache) params.set("nocache", "1");
        const res = await fetch(`/api/literature?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as FeedState;
        setFeed({
          articles: json.articles ?? [],
          sources: json.sources ?? [],
          query: json.query ?? "",
          fetchedAt: (json.fetchedAt as string) ?? new Date().toISOString(),
          fallback: Boolean(json.fallback),
        });
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [topics, query],
  );

  // Re-fetch when topics change (query searches are explicit via runSearch).
  useEffect(() => {
    void fetchFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics]);

  // Auto-refresh on an interval (silent — no skeleton flash).
  useEffect(() => {
    const id = setInterval(() => void fetchFeed({ silent: true }), REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchFeed]);

  const runSearch = useCallback(
    (q: string) => {
      setQuery(q);
      const uid = userId.current;
      if (uid && prefsTable.current) {
        void supabase.current
          .from("literature_prefs")
          .upsert({ user_id: uid, last_query: q, updated_at: new Date().toISOString() })
          .then(({ error: e }) => {
            if (e) {
              prefsTable.current = false;
              setPersistence({
                mode: "local",
                warning: "Search preference did not save to Supabase and is device-local for now.",
              });
            } else {
              setPersistence({ mode: "supabase", warning: null });
            }
          });
      }
      void fetchFeed({ nocache: false, queryOverride: q });
    },
    [fetchFeed],
  );

  const clearSearch = useCallback(() => {
    setQuery("");
    void fetchFeed({ queryOverride: "" });
  }, [fetchFeed]);

  return {
    topics,
    customTopics,
    query,
    setQuery,
    toggleTopic,
    setTopics,
    addCustomTopic,
    removeCustomTopic,
    feed,
    persistence,
    loading,
    error,
    refresh: () => fetchFeed({ nocache: true }),
    runSearch,
    clearSearch,
  };
}
