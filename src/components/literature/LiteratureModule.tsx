"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { useToast } from "@/components/ui/Toast";
import { type Article, TOPICS, useLiterature } from "@/lib/hooks/useLiterature";
import { createClient } from "@/lib/supabase/client";
import styles from "./LiteratureModule.module.css";

// ── Saved articles (offline) ──────────────────────────────────────────────────
const SAVED_LIT_KEY = "axis-lit-saved";

type SavedArticle = {
  id: string; title: string; summary: string;
  authors: string; source: string; publishedAt: string; url: string; savedAt: string;
  notes?: string; tags?: string[];
};

type LiteratureSavedRow = {
  article_id: string;
  title: string;
  authors: string | null;
  source: string | null;
  summary: string | null;
  url: string;
  published_at: string | null;
  created_at: string;
  notes?: string | null;
  tags?: string[] | null;
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

function rowToSaved(row: LiteratureSavedRow): SavedArticle {
  return {
    id: row.article_id,
    title: row.title,
    summary: row.summary ?? "",
    authors: row.authors ?? "",
    source: row.source ?? "",
    publishedAt: row.published_at ?? "",
    url: row.url,
    savedAt: row.created_at,
    notes: row.notes ?? "",
    tags: row.tags ?? [],
  };
}

function articleToSaved(a: Article): SavedArticle {
  return {
    id: a.id,
    title: a.title,
    summary: a.summary,
    authors: a.authors,
    source: a.source,
    publishedAt: a.publishedAt,
    url: a.url,
    savedAt: new Date().toISOString(),
    notes: "",
    tags: [],
  };
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
  const supabase = useMemo(() => createClient(), []);
  const {
    topics,
    customTopics,
    query,
    setQuery,
    toggleTopic,
    addCustomTopic,
    removeCustomTopic,
    feed,
    persistence,
    loading,
    error,
    refresh,
    runSearch,
    clearSearch,
  } = useLiterature();

  const [savedLit, setSavedLit] = useState<SavedArticle[]>([]);
  const [showSaved, setShowSaved] = useState(false);
  const [savedDetailId, setSavedDetailId] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState({ notes: "", tags: "" });
  const [savedPersisted, setSavedPersisted] = useState<"loading" | "supabase" | "local" | "error">("loading");

  const loadSaved = useCallback(async () => {
    const local = loadSavedLit();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSavedLit(local);
      setSavedPersisted("local");
      return;
    }
    const { data, error } = await supabase
      .from("literature_saved")
      .select("article_id,title,authors,source,summary,url,published_at,created_at,notes,tags")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) {
      setSavedLit(local);
      setSavedPersisted("error");
      toast("Saved papers are using this device only until Supabase literature_saved is available.", "warn", "Literature");
      return;
    }
    const rows = (data ?? []) as LiteratureSavedRow[];
    setSavedLit(rows.map(rowToSaved));
    setSavedPersisted("supabase");
  }, [supabase, toast]);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const selectedSaved = useMemo(
    () => savedLit.find((s) => s.id === savedDetailId) ?? null,
    [savedDetailId, savedLit],
  );

  useEffect(() => {
    if (!selectedSaved) {
      setSavedDraft({ notes: "", tags: "" });
      return;
    }
    setSavedDraft({
      notes: selectedSaved.notes ?? "",
      tags: (selectedSaved.tags ?? []).join(", "),
    });
  }, [selectedSaved]);

  const persistSavedPatch = useCallback(async (id: string, patch: Partial<SavedArticle>) => {
    setSavedLit((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, ...patch } : s));
      if (savedPersisted !== "supabase") persistSavedLit(next);
      return next;
    });
    if (savedPersisted !== "supabase") return true;
    const { error } = await supabase
      .from("literature_saved")
      .update({
        notes: patch.notes,
        tags: patch.tags,
      })
      .eq("article_id", id);
    if (error) {
      toast("Could not save paper notes/tags.", "error", "Literature");
      return false;
    }
    return true;
  }, [savedPersisted, supabase, toast]);

  const toggleSaveLit = async (a: Article | SavedArticle) => {
    const exists = savedLit.some((s) => s.id === a.id);
    const { data: { user } } = await supabase.auth.getUser();
    if (exists) {
      const next = savedLit.filter((s) => s.id !== a.id);
      setSavedLit(next);
      if (savedDetailId === a.id) setSavedDetailId(null);
      if (user && savedPersisted === "supabase") {
        const { error } = await supabase.from("literature_saved").delete().eq("user_id", user.id).eq("article_id", a.id);
        if (error) {
          toast("Could not remove saved paper.", "error", "Literature");
          await loadSaved();
          return;
        }
      } else {
        persistSavedLit(next);
      }
      toast("Removed from saved", "info", "Literature");
      return;
    }
    const saved = articleToSaved(a as Article);
    const next = [saved, ...savedLit];
    if (user && savedPersisted !== "error") {
      const { error } = await supabase.from("literature_saved").upsert({
        user_id: user.id,
        article_id: saved.id,
        title: saved.title,
        authors: saved.authors,
        source: saved.source,
        summary: saved.summary,
        url: saved.url,
        published_at: saved.publishedAt || null,
        notes: saved.notes,
        tags: saved.tags,
      }, { onConflict: "user_id,article_id" });
      if (error) {
        setSavedPersisted("error");
        persistSavedLit(next);
        toast("Saved locally. Apply the literature_saved migration for cross-device sync.", "warn", "Literature");
      } else {
        setSavedPersisted("supabase");
      }
    } else {
      persistSavedLit(next);
    }
    setSavedLit(next);
    setSavedDetailId(saved.id);
    toast(user ? "Paper saved" : "Saved on this device", "success", "Literature");
  };

  const saveSelectedMeta = async () => {
    if (!selectedSaved) return;
    const tags = savedDraft.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const ok = await persistSavedPatch(selectedSaved.id, { notes: savedDraft.notes, tags });
    if (ok) toast("Paper notes saved", "success", "Literature");
  };

  const createNoteFromPaper = async (paper: SavedArticle | Article) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to create notes from papers.", "warn", "Literature");
      return;
    }
    const body = [
      `<p><strong>${paper.title}</strong></p>`,
      `<p>${paper.authors}</p>`,
      `<p>${paper.source} · ${fmtDate(paper.publishedAt)}</p>`,
      `<p>${paper.summary}</p>`,
      "notes" in paper && paper.notes ? `<p><strong>Notes</strong><br/>${paper.notes.replace(/\n/g, "<br/>")}</p>` : "",
      `<p><a href="${paper.url}">${paper.url}</a></p>`,
    ].filter(Boolean).join("");
    const { error } = await supabase.from("notes").insert({
      user_id: user.id,
      title: paper.title,
      body,
      folder: "Research",
      tags: ["literature", ...("tags" in paper ? (paper.tags ?? []) : [])],
    });
    toast(error ? "Could not create note." : "Created literature note.", error ? "error" : "success", "Literature");
  };

  const addPaperToPipeline = async (paper: SavedArticle | Article) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast("Sign in to add papers to Pipeline.", "warn", "Literature");
      return;
    }
    const { data: stages } = await supabase
      .from("pipeline_stages")
      .select("id")
      .eq("user_id", user.id)
      .order("sort_order", { ascending: true })
      .limit(1);
    let stageId = stages?.[0]?.id as string | undefined;
    if (!stageId) {
      const { data: stage, error: stageError } = await supabase
        .from("pipeline_stages")
        .insert({ user_id: user.id, name: "Ideation", swatch: "var(--ink-faint)", sort_order: 0 })
        .select("id")
        .single();
      if (stageError || !stage) {
        toast("Could not prepare Pipeline stage.", "error", "Literature");
        return;
      }
      stageId = stage.id;
    }
    const { error } = await supabase.from("studies").insert({
      user_id: user.id,
      stage_id: stageId,
      title: paper.title,
      role: "First Author",
      meta: `${paper.source} · ${fmtDate(paper.publishedAt)}`,
      next_action: "Assess relevance and study design",
      sort_order: 0,
    });
    toast(error ? "Could not add to Pipeline." : "Added paper to Pipeline.", error ? "error" : "success", "Literature");
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
          mode: "literature-relevance",
          text: a.title,
          body: JSON.stringify({ summary: a.summary, authors: a.authors, source: a.source, topics }),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { relevance?: string };
      setWhy((w) => ({ ...w, [a.id]: json.relevance || "No relevance signal available." }));
    } catch {
      toast("Couldn't reach the assistant", "warn", "Literature");
    } finally {
      setWhyLoading(null);
    }
  };

  return (
    <>
      {persistence.warning && (
        <div className="module-status module-status-beta" style={{ marginBottom: 14 }}>
          <div>
            <div className="module-status-kicker">Beta persistence</div>
            <strong>Literature preferences are device-local right now.</strong>
            <p>{persistence.warning}</p>
          </div>
          <span>Saved papers still show their own sync state below.</span>
        </div>
      )}
        <button
          type="button"
          onClick={() => setShowSaved((v) => !v)}
          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".1em", color: showSaved ? "var(--accent)" : "var(--ink-faint)", display: "flex", alignItems: "center", gap: 5 }}
        >
          {showSaved ? "★" : "☆"} SAVED{savedLit.length > 0 ? ` (${savedLit.length})` : ""}
        </button>
      {persistence.warning && (
        <div className="module-status module-status-beta" style={{ marginTop: 10, marginBottom: 12 }}>
          <div>
            <div className="module-status-kicker">Literature persistence</div>
            <strong>Topic preferences are not fully synced.</strong>
            <p>{persistence.warning}</p>
          </div>
          <span>{persistence.mode === "local" ? "Saved papers still try Supabase first when signed in." : "Retry refresh after Supabase is available."}</span>
        </div>
      )}
      <div className="divider" />

      {/* Saved panel */}
      {showSaved && (
        <div style={{ marginBottom: 24, borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--surface-2)", padding: 16 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: savedPersisted === "supabase" ? "var(--up)" : "var(--ink-faint)", letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 10 }}>
            {savedPersisted === "supabase" ? "Synced to Supabase" : savedPersisted === "loading" ? "Loading saved papers" : "Device-only saved papers"}
          </div>
          {savedLit.length === 0 ? (
            <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>No saved articles yet. Click ☆ on any article to save it for offline reading.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, .8fr) minmax(280px, 1.2fr)", gap: 16 }}>
              <div>
                {savedLit.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSavedDetailId(s.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: selectedSaved?.id === s.id ? "var(--surface)" : "none",
                      border: "1px solid var(--line)",
                      borderRadius: "var(--r)",
                      padding: 10,
                      marginBottom: 8,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", letterSpacing: ".06em" }}>{s.source} · {fmtDate(s.publishedAt)}</div>
                    {(s.tags ?? []).length > 0 && (
                      <div className="tags" style={{ marginTop: 7 }}>
                        {(s.tags ?? []).slice(0, 3).map((t) => <span key={t} className="pill">{t}</span>)}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 14, background: "var(--surface)" }}>
                {selectedSaved ? (
                  <>
                    <div className="jrnl">{selectedSaved.source} · {fmtDate(selectedSaved.publishedAt)}</div>
                    <h3 style={{ color: "var(--ink)", fontSize: 18, margin: "6px 0" }}>{selectedSaved.title}</h3>
                    <div className="auth">{selectedSaved.authors || "Unknown authors"}</div>
                    <p style={{ color: "var(--ink-dim)", lineHeight: 1.65 }}>{selectedSaved.summary || "No abstract available."}</p>
                    <label style={{ display: "block", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", marginBottom: 5 }}>Notes</label>
                    <textarea
                      value={savedDraft.notes}
                      onChange={(e) => setSavedDraft((d) => ({ ...d, notes: e.target.value }))}
                      rows={5}
                      style={{ width: "100%", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--surface-2)", color: "var(--ink)", padding: 10, fontFamily: "var(--sans)", fontSize: 13, resize: "vertical" }}
                    />
                    <label style={{ display: "block", fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-faint)", margin: "10px 0 5px" }}>Tags</label>
                    <input
                      value={savedDraft.tags}
                      onChange={(e) => setSavedDraft((d) => ({ ...d, tags: e.target.value }))}
                      placeholder="methodology, dbs, review"
                      style={{ width: "100%", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--surface-2)", color: "var(--ink)", padding: 10, fontSize: 13 }}
                    />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                      <button type="button" className="savebtn" onClick={saveSelectedMeta}>Save notes/tags</button>
                      <button type="button" className="savebtn" onClick={() => openInApp(selectedSaved.url, selectedSaved.title)}>Open source →</button>
                      <button type="button" className="savebtn" onClick={() => createNoteFromPaper(selectedSaved)}>Create note</button>
                      <button type="button" className="savebtn" onClick={() => addPaperToPipeline(selectedSaved)}>Add to Pipeline</button>
                      <button type="button" className="savebtn" onClick={() => toggleSaveLit(selectedSaved)} style={{ color: "var(--down)", borderColor: "var(--down)" }}>Remove</button>
                    </div>
                  </>
                ) : (
                  <p style={{ color: "var(--ink-faint)", fontSize: 13, margin: 0 }}>Select a saved paper to review its detail, notes, and tags.</p>
                )}
              </div>
            </div>
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
          <button
            type="button"
            className={styles.litHeader}
            onClick={() => openInApp(reader.url, reader.title)}
            title="Open in app"
          >
            <span className={styles.litHeaderSource}>{fmtDate(reader.publishedAt)}</span>
            <span className={styles.litHeaderOpen}>Open in app →</span>
          </button>
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
                  onClick={(e) => { e.stopPropagation(); createNoteFromPaper(a); }}
                >
                  Note
                </button>
                <button
                  type="button"
                  className="savebtn"
                  onClick={(e) => { e.stopPropagation(); addPaperToPipeline(a); }}
                >
                  Pipeline
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
