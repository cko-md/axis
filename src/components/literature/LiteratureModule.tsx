"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { type Article, TOPICS, useLiterature } from "@/lib/hooks/useLiterature";
import styles from "./LiteratureModule.module.css";

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
      <div className="modhead">
        <div className="eyebrow">Research</div>
        <div className="rule" />
      </div>
      <h1 className="hero">Literature</h1>
      <div className="divider" />

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
            <span
              style={{
                position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)",
                fontSize: 9, cursor: "pointer", color: "var(--ink-faint)", lineHeight: 1,
              }}
              onClick={(e) => { e.stopPropagation(); removeCustomTopic(t.key); }}
              title="Remove topic"
            >✕</span>
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
            <span
              style={{ cursor: "pointer", color: "var(--ink-faint)", fontSize: 11 }}
              onClick={() => { setTopicDraft(""); setAddingTopic(false); }}
            >✕</span>
          </span>
        ) : (
          <span
            className="chip"
            onClick={() => setAddingTopic(true)}
            style={{ color: "var(--ink-faint)", borderStyle: "dashed" }}
            title="Add custom topic"
          >+ Topic</span>
        )}
        {query && (
          <span className="chip on" onClick={() => { setDraft(""); clearSearch(); }}>
            ✕ "{query}"
          </span>
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
              <a className={styles.openLink} href={reader.url} target="_blank" rel="noreferrer">
                Open source ↗
              </a>
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
              <a
                className="savebtn"
                href={a.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                </svg>
                Open
              </a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
