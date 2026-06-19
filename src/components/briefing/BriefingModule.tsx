"use client";

import { useCallback, useEffect, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { useToast } from "@/components/ui/Toast";

const SAVED_KEY = "axis-briefing-saved";
type SavedItem = { id: string; title: string; url: string; savedAt: string; type: "read" | "watch" };

function loadSaved(): SavedItem[] {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"); } catch { return []; }
}
function persistSaved(items: SavedItem[]) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(items));
}

type Story = {
  id: string;
  cat: string;
  title: string;
  shortTitle: string;
  src: string;
  srcLong: string;
  body: string;
  gradient: string;
  url: string;
  size?: "big" | "wide";
  video?: boolean;
  image?: string | null;
};

const STORIES: Story[] = [
  {
    id: "tems",
    cat: "Black & Nigerian",
    title: "Tems on Producing in Lagos and the New Wave of Afro-Fusion",
    shortTitle: "Tems on Producing in Lagos and the New Wave of Afro-Fusion",
    src: "THE NATIVE · 5h",
    srcLong: "THE NATIVE · 5h AGO · 11 MIN WATCH",
    body: "The conversation traces a deliberate creative path: building a studio ecosystem at home, resisting the pull to relocate, and treating the diaspora as a network to collaborate across rather than an audience to chase.",
    gradient: "linear-gradient(135deg,#242030,#10141b)",
    url: "https://www.nativemag.com",
    size: "big",
    video: true,
  },
  {
    id: "fus",
    cat: "Health",
    title: "Focused Ultrasound Expands Beyond Tremor Into Psychiatry Trials",
    shortTitle: "Focused Ultrasound Expands Into Psychiatry Trials",
    src: "STAT · 2h",
    srcLong: "STAT · 2h AGO · 6 MIN READ",
    body: "Trial sponsors are pushing incisionless lesioning past movement disorders into OCD and depression — with stereotactic teams watching the targeting data closely.",
    gradient: "linear-gradient(135deg,#16252a,#10141b)",
    url: "https://www.statnews.com",
  },
  {
    id: "tsy",
    cat: "Finance",
    title: "Why Long-Duration Treasuries Are Back in Favor",
    shortTitle: "Why Long-Duration Treasuries Are Back in Favor",
    src: "BLOOMBERG · 4h",
    srcLong: "BLOOMBERG · 4h AGO · 5 MIN READ",
    body: "Duration is being treated as portfolio insurance again as growth data softens — a shift with implications for the long end of the curve.",
    gradient: "linear-gradient(135deg,#1d2330,#10141b)",
    url: "https://www.bloomberg.com",
  },
  {
    id: "ondevice",
    cat: "Tech",
    title: "On-Device Models Quietly Reshape Clinical Decision Tools",
    shortTitle: "On-Device Models Reshape Clinical Decision Tools",
    src: "THE VERGE · 7h",
    srcLong: "THE VERGE · 7h AGO · 8 MIN READ",
    body: "Smaller local models are clearing privacy review faster than cloud inference, and bedside decision-support pilots are the early beneficiaries.",
    gradient: "linear-gradient(135deg,#1a2433,#10141b)",
    url: "https://www.theverge.com",
    size: "wide",
  },
  {
    id: "semis",
    cat: "Finance",
    title: "Semis: AI Capex Durability vs. Valuation",
    shortTitle: "Semis: AI Capex Durability vs. Valuation",
    src: "FT · 1d",
    srcLong: "FT · 1d AGO · 7 MIN READ",
    body: "The bull case rests on data-center capex staying durable through 2027; the bear case is simply the multiple.",
    gradient: "linear-gradient(135deg,#22262f,#10141b)",
    url: "https://www.ft.com",
  },
];

const CHIPS: { label: string; f: string; on: boolean }[] = [
  { label: "All", f: "all", on: true },
  { label: "Health", f: "health", on: true },
  { label: "Tech", f: "tech", on: true },
  { label: "Style", f: "style", on: false },
  { label: "Finance", f: "finance", on: true },
  { label: "Philosophy", f: "philosophy", on: false },
  { label: "Black & Nigerian", f: "black-nigerian", on: true },
  { label: "Pop", f: "pop", on: false },
  { label: "Music", f: "music", on: false },
];

const CAT_TO_FILTER: Record<string, string> = {
  Health: "health",
  Tech: "tech",
  Finance: "finance",
  "Black & Nigerian": "black-nigerian",
};

const FEED_GRADIENTS = [
  "linear-gradient(135deg,#1a2030,#10141b)",
  "linear-gradient(135deg,#16252a,#10141b)",
  "linear-gradient(135deg,#1d2330,#10141b)",
  "linear-gradient(135deg,#22262f,#10141b)",
  "linear-gradient(135deg,#1a2433,#10141b)",
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "< 1h";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function BriefingModule() {
  const { open: openInApp } = useWebViewer();
  const { toast } = useToast();
  const [active, setActive] = useState<Set<string>>(
    () => new Set(CHIPS.filter((c) => c.on).map((c) => c.f)),
  );
  const [readerId, setReaderId] = useState<string>(STORIES[0].id);
  const [saved, setSaved] = useState<SavedItem[]>(() => loadSaved());
  const [showSaved, setShowSaved] = useState(false);

  const [feedSearchOpen, setFeedSearchOpen] = useState(false);
  const [feedQuery, setFeedQuery] = useState("");
  const [feedSearching, setFeedSearching] = useState(false);
  const [feedResults, setFeedResults] = useState<Array<{name: string; url: string; description: string}>>([]);
  const [savedFeeds, setSavedFeeds] = useState<Array<{name: string; url: string}>>(() => {
    try { return JSON.parse(localStorage.getItem("axis-briefing-feeds") ?? "[]"); } catch { return []; }
  });
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [feedItems, setFeedItems] = useState<Story[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(false);

  // Load real RSS items (with preview images) from the saved feeds.
  const loadFeeds = useCallback((opts?: { silent?: boolean }) => {
    if (savedFeeds.length === 0) { setFeedItems([]); return; }
    if (!opts?.silent) setFeedsLoading(true);
    fetch("/api/briefing/fetch-feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedUrls: savedFeeds.map((f) => f.url) }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const items: Story[] = (data.items ?? []).map(
          (item: { id: string; title: string; url: string; source: string; date: string; body: string; image?: string | null }, i: number) => ({
            id: `feed-${item.id ?? i}`,
            cat: item.source ?? "Feed",
            title: item.title,
            shortTitle: item.title.slice(0, 70),
            src: `${item.source ?? "Feed"} · ${relativeTime(item.date)}`,
            srcLong: `${item.source ?? "Feed"} · ${relativeTime(item.date)} · 5 MIN READ`,
            body: item.body || "Click to read the full article.",
            gradient: FEED_GRADIENTS[i % FEED_GRADIENTS.length],
            url: item.url,
            image: item.image ?? null,
          }),
        );
        setFeedItems(items);
      })
      .catch(() => {})
      .finally(() => { if (!opts?.silent) setFeedsLoading(false); });
  }, [savedFeeds]);

  // Load on mount + whenever feeds change; refresh silently every 5 minutes
  // so headlines and preview images stay current while the board is open.
  useEffect(() => {
    loadFeeds();
    const id = setInterval(() => loadFeeds({ silent: true }), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadFeeds]);

  const toggleChip = (f: string) => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const toggleSave = (s: Story, type: "read" | "watch" = "read") => {
    const already = saved.find((x) => x.id === s.id);
    const next = already
      ? saved.filter((x) => x.id !== s.id)
      : [...saved, { id: s.id, title: s.shortTitle, url: s.url, savedAt: new Date().toISOString(), type }];
    setSaved(next);
    persistSaved(next);
    toast(already ? "Removed from saved" : `Saved for ${type === "watch" ? "later" : "reading"}`, "success", "Briefing");
  };

  const searchFeeds = async () => {
    if (!feedQuery.trim()) return;
    setFeedSearching(true);
    try {
      const res = await fetch("/api/briefing/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: feedQuery }),
      });
      if (res.ok) {
        const data = await res.json();
        setFeedResults(data.feeds ?? []);
      }
    } finally {
      setFeedSearching(false);
    }
  };

  const saveFeed = (feed: {name: string; url: string}) => {
    const next = [...savedFeeds.filter(f => f.url !== feed.url), feed];
    setSavedFeeds(next);
    localStorage.setItem("axis-briefing-feeds", JSON.stringify(next));
    toast(`${feed.name} added to sources.`, "success", "Briefing");
  };

  const removeFeed = (url: string) => {
    const next = savedFeeds.filter(f => f.url !== url);
    setSavedFeeds(next);
    localStorage.setItem("axis-briefing-feeds", JSON.stringify(next));
  };

  const allStories = [...STORIES, ...feedItems];
  const visible = active.has("all")
    ? allStories
    : allStories.filter((s) => active.has(CAT_TO_FILTER[s.cat] ?? "feed") || feedItems.some((fi) => fi.id === s.id));

  const reader = allStories.find((s) => s.id === readerId) ?? STORIES[0];

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <button
          type="button"
          className="feed-manage"
          style={{ fontSize: 10.5, color: saved.length > 0 ? "var(--gold)" : undefined }}
          onClick={() => setShowSaved((s) => !s)}
        >
          {showSaved ? "← All" : `★ Saved${saved.length > 0 ? ` (${saved.length})` : ""}`}
        </button>
      </div>
      <div className="divider" />
      <div className="feedbar">
        <div className="feedbar-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
          <input placeholder="Describe a topic, source, or feed to follow — e.g. 'neurosurgery RCTs', 'Nigerian football', a site URL…" />
          <button type="button" className="feed-go" onClick={() => setFeedSearchOpen(true)}>✦ Find Feeds</button>
        </div>
        <button type="button" className="feed-manage" onClick={() => setSourcesOpen(true)}>Manage Sources</button>
      </div>
      {feedsLoading && (
        <p style={{ fontSize: 10.5, color: "var(--ink-faint)", fontFamily: "var(--mono)", padding: "4px 0" }}>
          Fetching feeds…
        </p>
      )}
      {feedItems.length > 0 && !feedsLoading && (
        <p style={{ fontSize: 10.5, color: "var(--ink-faint)", fontFamily: "var(--mono)", padding: "4px 0" }}>
          {feedItems.length} article{feedItems.length !== 1 ? "s" : ""} from your feeds
        </p>
      )}
      <div className="feed-suggest" />
      <div className="chips">
        {CHIPS.map((c) => (
          <span
            key={c.f}
            className={`chip${active.has(c.f) ? " on" : ""}`}
            onClick={() => toggleChip(c.f)}
          >
            {c.label}
          </span>
        ))}
      </div>
      <div className="reader">
        <div
          className="r-media"
          style={reader.image ? { backgroundImage: `url(${reader.image})`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
        >
          <div className="play" onClick={() => openInApp(reader.url, reader.shortTitle)} style={{ cursor: "pointer" }} title="Open in app" />
          <div className="scrub">
            <span>02:14</span>
            <div className="bar" />
            <span>11:38</span>
          </div>
        </div>
        <div className="r-body">
          <div className="r-cat">{reader.cat}</div>
          <h2>{reader.title}</h2>
          <div className="r-src">{reader.srcLong}</div>
          <p>{reader.body}</p>
          <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="sig-go"
              onClick={() => openInApp(reader.url, reader.shortTitle)}
              style={{ fontSize: 11 }}
            >
              {reader.video ? "Watch in-app →" : "Read in-app →"}
            </button>
            <a
              href={reader.url}
              target="_blank"
              rel="noopener noreferrer"
              className="feed-manage"
              style={{ fontSize: 11, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              onClick={(e) => { e.preventDefault(); openInApp(reader.url, reader.shortTitle); }}
            >
              {reader.src.split(" · ")[0]} ↗
            </a>
            <button
              type="button"
              className="feed-manage"
              style={{ fontSize: 11, color: saved.some((x) => x.id === reader.id) ? "var(--gold)" : undefined }}
              onClick={() => toggleSave(reader, reader.video ? "watch" : "read")}
              title={saved.some((x) => x.id === reader.id) ? "Remove from saved" : "Save for later"}
            >
              {saved.some((x) => x.id === reader.id) ? "★ Saved" : "☆ Save"}
            </button>
          </div>
        </div>
      </div>
      {/* Saved content panel */}
      {showSaved && (
        <div style={{ marginBottom: 20 }}>
          <h2 className="sec" style={{ marginBottom: 12 }}>Saved<span className="rule" /><span className="count">{saved.length} items</span></h2>
          {saved.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--ink-faint)" }}>Nothing saved yet — star stories to read or watch later.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {saved.map((item) => (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: "var(--glass)", borderRadius: "var(--r)", border: "1px solid var(--line)" }}>
                  <span style={{ fontSize: 9, fontFamily: "var(--narrow)", letterSpacing: ".08em", color: "var(--gold)", textTransform: "uppercase", flexShrink: 0 }}>{item.type}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</div>
                  </div>
                  <button type="button" className="feed-manage" style={{ fontSize: 10.5 }} onClick={() => openInApp(item.url, item.title)}>Open →</button>
                  <button type="button" className="feed-manage" style={{ fontSize: 10.5 }} onClick={() => { setSaved((s) => { const n = s.filter((x) => x.id !== item.id); persistSaved(n); return n; }); }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Feed Search Modal */}
      {feedSearchOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setFeedSearchOpen(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--rl)", padding: 24, width: "min(540px,92vw)", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--narrow)", fontWeight: 600, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--ink-2)" }}>Find Feeds</span>
              <button type="button" onClick={() => setFeedSearchOpen(false)} style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                value={feedQuery}
                onChange={e => setFeedQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && void searchFeeds()}
                placeholder="Topic or feed URL…"
                autoFocus
                style={{ flex: 1, background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "7px 12px", color: "var(--ink)", fontFamily: "var(--sans)", fontSize: 13, outline: "none" }}
              />
              <button type="button" className="feed-go" onClick={() => void searchFeeds()} disabled={feedSearching} style={{ padding: "7px 14px" }}>
                {feedSearching ? "…" : "Search"}
              </button>
            </div>
            {feedResults.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {feedResults.map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px", background: "var(--glass)", border: "1px solid var(--line)", borderRadius: "var(--r)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500, marginBottom: 2 }}>{f.name}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-dim)", marginBottom: 3 }}>{f.description}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.url}</div>
                    </div>
                    <button type="button" className="feed-go" style={{ flexShrink: 0, padding: "5px 10px", fontSize: 10 }} onClick={() => saveFeed({ name: f.name, url: f.url })}>
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!feedSearching && feedResults.length === 0 && feedQuery.trim() && (
              <p style={{ fontSize: 12, color: "var(--ink-faint)", textAlign: "center", padding: "16px 0" }}>No results yet — try a different topic.</p>
            )}
          </div>
        </div>
      )}

      {/* Manage Sources Modal */}
      {sourcesOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setSourcesOpen(false)}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--rl)", padding: 24, width: "min(480px,92vw)", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--narrow)", fontWeight: 600, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--ink-2)" }}>Your Sources ({savedFeeds.length})</span>
              <button type="button" onClick={() => setSourcesOpen(false)} style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
            {savedFeeds.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--ink-faint)", padding: "16px 0" }}>No feeds saved yet — use Find Feeds to add sources.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {savedFeeds.map((f) => (
                  <div key={f.url} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "var(--glass)", border: "1px solid var(--line)", borderRadius: "var(--r)" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--ink)", fontWeight: 500, marginBottom: 2 }}>{f.name}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--ink-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.url}</div>
                    </div>
                    <button type="button" className="feed-manage" style={{ fontSize: 10.5, flexShrink: 0 }} onClick={() => removeFeed(f.url)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bento">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`ncard${s.video ? " video" : ""}${s.size === "big" ? " big" : ""}${s.size === "wide" ? " wide" : ""}`}
            onClick={() => setReaderId(s.id)}
            onDoubleClick={() => openInApp(s.url, s.shortTitle)}
            title={`Click to preview · Double-click to read in-app`}
          >
            <div
              className="thumb"
              style={s.image ? { backgroundImage: `url(${s.image})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: s.gradient }}
            >
              <div className="nc-cat">{s.cat}</div>
              {s.video && (
                <div className="play">
                  <span />
                </div>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleSave(s, s.video ? "watch" : "read"); }}
                style={{ position: "absolute", top: 7, right: 7, background: "rgba(7,8,11,.55)", border: "none", borderRadius: 3, width: 24, height: 24, display: "grid", placeItems: "center", cursor: "pointer", color: saved.some((x) => x.id === s.id) ? "#c9a463" : "rgba(193,196,199,.7)", fontSize: 12 }}
                title={saved.some((x) => x.id === s.id) ? "Remove from saved" : "Save for later"}
              >
                {saved.some((x) => x.id === s.id) ? "★" : "☆"}
              </button>
            </div>
            <div className="nc-b">
              <h4>{s.shortTitle}</h4>
              {s.id.startsWith("feed-") && s.body && (
                <p
                  style={{
                    fontSize: 10.5,
                    lineHeight: 1.5,
                    color: "var(--ink-faint)",
                    margin: 0,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {s.body}
                </p>
              )}
              <div className="nc-src">
                <span>{s.src.split(" · ")[0]}</span>
                <span>{s.src.split(" · ")[1]}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
