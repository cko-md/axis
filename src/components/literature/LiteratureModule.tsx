"use client";

import { useEffect, useMemo, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { useToast } from "@/components/ui/Toast";
import { type Article, TOPICS, useLiterature } from "@/lib/hooks/useLiterature";
import styles from "./LiteratureModule.module.css";

// ── Saved articles (offline) ──────────────────────────────────────────────────
const SAVED_LIT_KEY = "axis-lit-saved";

type SavedArticle = {
  id: string; title: string; summary: string;
  authors: string; source: string; publishedAt: string; url: string; savedAt: string;
};

function loadSavedLit(): SavedArticle[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(SAVED_LIT_KEY) ?? "[]"); }
  catch { return []; }
}

function persistSavedLit(items: SavedArticle[]) {
  try { localStorage.setItem(SAVED_LIT_KEY, JSON.stringify(items)); }
  catch { /* ignore */ }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function LiteratureModule() {
  const { toast } = useToast();
  const { open: openInApp } = useWebViewer();
  const {
    topics,
    customTopics,
    query,
    setQuery,
    toggleTopic,
    addCustomTopic,
    removeCustomTopic,
    feed,
    loading,
    error,
    refresh,
    runSearch,
    clearSearch,
  } = useLiterature();

  const [savedLit, setSavedLit] = useState<SavedArticle[]>([]);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => { setSavedLit(loadSavedLit()); }, []);

  const toggleSaveLit = (a: Article) => {
    setSavedLit((prev) => {
      const exists = prev.some((s) => s.id === a.id);
      const next = exists
        ? prev.filter((s) => s.id !== a.id)
        : [...prev, { id: a.id, title: a.title, summary: a.summary, authors: a.authors, source: a.source, publishedAt: a.publishedAt, url: a.url, savedAt: new Date().toISOString() }];
      persistSavedLit(next);
      toast(exists ? "Removed from saved" : "Saved for offline reading", exists ? "info" : "success", "Literature");
      return next;
    });
  };

  const [addingTopic, setAddingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");

  const [readerId, setReaderId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // "why it matters" results keyed by article id
  const [why, setWhy] = useState<Record<string, string>>({});
  const [whyLoading, setWhyLoading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [, force] = useState(0);

  // keep the "updated Xm ago" label ticking
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // keep the reader pointed at a valid article as the feed changes
  const reader: Article | null = useMemo(() => {
    if (!feed.articles.length) return null;
    return feed.articles.find((a) => a.id === readerId) ?? feed.articles[0];
  }, [feed.articles, readerId]);

  const sourcesDown = feed.sources.filter((s) => !s.ok);
  const dotClass = error
    ? `${styles.dot} ${styles.down}`
    : sourcesDown.length
      ? `${styles.dot} ${styles.stale}`
      : styles.dot;

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
    toast("Feed refreshed", "success", "Literature");
  };

  const onSearch = () => {
    const q = draft.trim();
    if (!q) {
      clearSearch();
      return;
    }
    runSearch(q);
  };

  const askWhy = async (a: Article) => {
    setWhyLoading(a.id);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "capture",
          text: `Why might this paper matter to a neuroscience research student? One or two sentences. "${a.title}" — ${a.summary}`,
        }),
      });
      const json = (await res.json()) as { action?: string; label?: string };
      const note =
        json.action && json.label
          ? `${json.label}: ${json.action}`
          : json.action || json.label || "No relevance signal available.";
      setWhy((w) => ({ ...w, [a.id]: note }));
    } catch {
      toast("Couldn't reach the assistant", "warn", "Literature");
    } finally {
      setWhyLoading(null);
    }
  };

  return (
    <>
        <button
          type="button"
          onClick={() => setShowSaved((v) => !v)}
          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em", color: showSaved ? "var(--accent)" : "var(--ink-faint)", display: "flex", alignItems: "center", gap: 5 }}
        >
          {showSaved ? "★" : "☆"} SAVED{savedLit.length > 0 ? ` (${savedLit.length})` : ""}
        </button>
      <div className="divider" />

      {/* Saved panel */}
      {showSaved && (
        <div style={{ marginBottom: 24, borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface-2)", padding: 16 }}>
          {savedLit.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>No saved articles yet. Click ☆ on any article to save it for offline reading.</p>
          ) : (
            savedLit.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 500, color: "var(--ink)", marginBottom: 2, lineClamp: 2 }}>{s.title}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", letterSpacing: ".06em" }}>{s.source} · {fmtDate(s.publishedAt)}</div>
                </div>
                <button type="button" onClick={() => openInApp(s.url, s.title)} style={{ background: "none", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "3px 10px", fontSize: 11, color: "var(--ink-faint)", cursor: "pointer", whiteSpace: "nowrap" }}>Open →</button>
                <button type="button" onClick={() => toggleSaveLit(s as unknown as Article)} style={{ background: "none", border: "none", fontSize: 14, cursor: "pointer", color: "var(--accent)", padding: 0 }} title="Remove">★</button>
              </div>
            ))
          )}
        </div>
      )}

      {/* search */}
      <div className="routebar">
        <div className="feedbar-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSearch();
            }}
            placeholder="Search a topic — e.g. 'directional DBS dystonia', 'Fine–Gray competing risks'…"
          />
        </div>
        <button type="button" className="sig-go" onClick={onSearch}>
          Search
        </button>
      </div>

      {/* topic chips (selectable, persisted) */}
      <div className="chips">
        {TOPICS.map((t) => (
          <span
            key={t.key}
            className={`chip${topics.includes(t.key) && !query ? " on" : ""}`}
            onClick={() => {
              if (query) { setDraft(""); clearSearch(); setQuery(""); }
              toggleTopic(t.key);
            }}
          >
            {t.label}
          </span>
        ))}
        {customTopics.map((t) => (
          <span
            key={t.key}
            className={`chip${topics.includes(t.key) && !query ? " on" : ""}`}
            style={{ position: "relative", paddingRight: 22 }}
            onClick={() => {
              if (query) { setDraft(""); clearSearch(); setQuery(""); }
              toggleTopic(t.key);
            }}
          >
            {t.label}
            <button
              type="button"
              aria-label={`Remove topic ${t.label}`}
              style={{
                position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)",
                fontSize: 9, cursor: "pointer", color: "var(--ink-faint)", lineHeight: 1,
                background: "none", border: "none", padding: 0,
              }}
              onClick={(e) => { e.stopPropagation(); removeCustomTopic(t.key); }}
              title="Remove topic"
            >✕</button>
          </span>
        ))}
        {addingTopic ? (
          <span className="chip" style={{ padding: "0 4px", gap: 4, display: "inline-flex", alignItems: "center" }}>
            <input
              autoFocus
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && topicDraft.trim()) {
                  addCustomTopic(topicDraft.trim());
                  setTopicDraft("");
                  setAddingTopic(false);
                }
                if (e.key === "Escape") { setTopicDraft(""); setAddingTopic(false); }
              }}
              placeholder="Topic name…"
              style={{
                background: "none", border: "none", outline: "none",
                color: "var(--ink)", fontFamily: "var(--narrow)", fontSize: 10.5,
                letterSpacing: ".08em", textTransform: "uppercase", width: 110,
              }}
            />
            <button
              type="button"
              aria-label="Cancel adding topic"
              style={{ cursor: "pointer", color: "var(--ink-faint)", fontSize: 11, background: "none", border: "none", padding: 0 }}
              onClick={() => { setTopicDraft(""); setAddingTopic(false); }}
            >✕</button>
          </span>
        ) : (
          <button
            type="button"
            className="chip"
            onClick={() => setAddingTopic(true)}
            style={{ color: "var(--ink-faint)", borderStyle: "dashed" }}
            title="Add custom topic"
          >+ Topic</button>
        )}
        {query && (
          <button type="button" className="chip on" aria-label={`Clear search for "${query}"`} onClick={() => { setDraft(""); clearSearch(); }}>
            ✕ &quot;{query}&quot;
          </button>
        )}
      </div>

      {/* status + refresh */}
      <div className={styles.toolbar}>
        <span className={styles.status}>
          <span className={dotClass} />
          {error
            ? "Sources unreachable"
            : feed.fetchedAt
              ? `Updated ${relTime(feed.fetchedAt)}`
              : "Loading"}
        </span>
        {feed.sources.length > 0 && (
          <span className={styles.status} style={{ color: "var(--ink-faint)" }}>
            {feed.sources.map((s) => `${s.name} ${s.ok ? s.count : "—"}`).join("  ·  ")}
          </span>
        )}
        <button
          type="button"
          className={styles.refresh}
          onClick={onRefresh}
          disabled={refreshing || loading}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className={refreshing ? styles.spin : undefined}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
          Refresh
        </button>
      </div>

      {/* reader (split editorial) */}
      {reader && (
        <div className="reader">
          <div className="r-media">
            <div className="play" />
            <div className="scrub">
              <span>{reader.source}</span>
              <div className="bar" />
              <span>{fmtDate(reader.publishedAt)}</span>
            </div>
          </div>
          <div className="r-body">
            <div className="r-cat">{reader.source}</div>
            <h2>{reader.title}</h2>
            <div className="r-src">
              {reader.authors} · {fmtDate(reader.publishedAt)}
            </div>
            <p>{reader.summary}</p>
            <div className={styles.readerActions}>
              <button
                type="button"
                className={styles.openLink}
                onClick={() => openInApp(reader.url, reader.title)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit", color: "inherit" }}
              >
                Read in-app →
              </button>
              <button
                type="button"
                className={styles.whyBtn}
                onClick={() => askWhy(reader)}
                disabled={whyLoading === reader.id}
              >
                {whyLoading === reader.id ? "Thinking…" : "✦ Why it matters"}
              </button>
            </div>
            {why[reader.id] && (
              <div className={styles.why}>
                <div className={styles.whyHead}>✦ Why it matters</div>
                <p>{why[reader.id]}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* feed grid */}
      {loading && feed.articles.length === 0 ? (
        <div className={`grid ${styles.feedgrid}`}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={styles.skeleton} />
          ))}
        </div>
      ) : feed.articles.length === 0 ? (
        <div className="empty-state">
          <div className="eyebrow">No articles right now</div>
          <p>
            {error
              ? "The literature sources couldn't be reached. Try Refresh in a moment."
              : "No recent matches for this selection. Try another topic or a broader search."}
          </p>
        </div>
      ) : (
        <div className={`grid ${styles.feedgrid}`}>
          {feed.articles.map((a) => (
            <div
              key={a.id}
              className={`card litcard ${styles.clickable}${reader?.id === a.id ? ` ${styles.active}` : ""}`}
              onClick={() => setReaderId(a.id)}
            >
              <div>
                <div className="jrnl">
                  {a.source} · {fmtDate(a.publishedAt)}
                </div>
                <h3>{a.title}</h3>
                <div className="auth">{a.authors}</div>
                <p>{a.summary}</p>
                <div className="tags">
                  <span className="pill med">{a.source}</span>
                  {a.id.startsWith("pmid:") && <span className="pill">Peer-reviewed</span>}
                  {(a.id.startsWith("doi:") || a.id.startsWith("arxiv:")) && (
                    <span className="pill lo">Preprint</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleSaveLit(a); }}
                  title={savedLit.some((s) => s.id === a.id) ? "Remove from saved" : "Save for offline"}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: savedLit.some((s) => s.id === a.id) ? "var(--accent)" : "var(--ink-faint)", padding: "0 2px", lineHeight: 1 }}
                >
                  {savedLit.some((s) => s.id === a.id) ? "★" : "☆"}
                </button>
                <button
                  type="button"
                  className="savebtn"
                  onClick={(e) => { e.stopPropagation(); openInApp(a.url, a.title); }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                  </svg>
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
