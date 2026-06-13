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

export const TOPICS: { key: string; label: string }[] = [
  { key: "neuroscience", label: "Neuroscience" },
  { key: "dbs", label: "DBS / Functional" },
  { key: "connectomics", label: "Connectomics" },
  { key: "neurooncology", label: "Neuro-Oncology" },
  { key: "methods", label: "Methods / Stats" },
];

const VALID = new Set(TOPICS.map((t) => t.key));
const LS_KEY = "axis.literature.topics";
const REFRESH_MS = 4 * 60 * 1000; // 4 minutes

function readLocalTopics(): string[] {
  if (typeof window === "undefined") return ["neuroscience"];
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return ["neuroscience"];
    const arr = (JSON.parse(raw) as string[]).filter((t) => VALID.has(t));
    return arr.length ? arr : ["neuroscience"];
  } catch {
    return ["neuroscience"];
  }
}

function writeLocalTopics(topics: string[]) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(topics));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function useLiterature() {
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

  const supabase = useRef(createClient());
  const userId = useRef<string | null>(null);
  const prefsTable = useRef(true); // flips false if the table is missing — falls back to localStorage

  // ── Load persisted topic selection: Supabase for signed-in users, else localStorage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = readLocalTopics();
      if (!cancelled) setTopicsState(local);
      try {
        const { data: auth } = await supabase.current.auth.getUser();
        const uid = auth.user?.id ?? null;
        userId.current = uid;
        if (!uid) return;
        const { data, error: e } = await supabase.current
          .from("literature_prefs")
          .select("topics,last_query")
          .eq("user_id", uid)
          .maybeSingle();
        if (e) {
          // Table likely not applied yet — degrade to localStorage silently.
          prefsTable.current = false;
          return;
        }
        if (!cancelled && data?.topics?.length) {
          const valid = (data.topics as string[]).filter((t) => VALID.has(t));
          if (valid.length) {
            setTopicsState(valid);
            writeLocalTopics(valid);
          }
        }
        if (!cancelled && typeof data?.last_query === "string") setQuery(data.last_query);
      } catch {
        prefsTable.current = false;
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
          if (e) prefsTable.current = false;
        });
    }
  }, []);

  const setTopics = useCallback(
    (next: string[]) => {
      const cleaned = next.filter((t) => VALID.has(t));
      const final = cleaned.length ? cleaned : ["neuroscience"];
      setTopicsState(final);
      persistTopics(final);
    },
    [persistTopics],
  );

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
    async (opts?: { silent?: boolean; nocache?: boolean }) => {
      if (!opts?.silent) setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
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
          .upsert({ user_id: uid, last_query: q, updated_at: new Date().toISOString() });
      }
      // fetch immediately with the new query rather than waiting for state batch
      setTimeout(() => void fetchFeed({ nocache: false }), 0);
    },
    [fetchFeed],
  );

  const clearSearch = useCallback(() => {
    setQuery("");
    setTimeout(() => void fetchFeed(), 0);
  }, [fetchFeed]);

  return {
    topics,
    query,
    setQuery,
    toggleTopic,
    setTopics,
    feed,
    loading,
    error,
    refresh: () => fetchFeed({ nocache: true }),
    runSearch,
    clearSearch,
  };
}
