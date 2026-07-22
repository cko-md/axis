"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { useToast } from "@/components/ui/Toast";
import { StatusCallout } from "@/components/ui/StatusCallout";
import { ModuleInteractiveHero, type HeroStatTone } from "@/components/ui/axis/ModuleInteractiveHero";
import { useBriefing } from "@/lib/hooks/useBriefing";

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
    url: "https://thenativemag.com/cover-story/tems/",
    size: "big",
    video: true,
  },
  {
    id: "fus",
    cat: "Health",
    title: "Focused Ultrasound's Uphill Battle to Treat Uterine Fibroids",
    shortTitle: "Focused Ultrasound's Uphill Battle With Fibroids",
    src: "STAT · 2h",
    srcLong: "STAT · 2h AGO · 6 MIN READ",
    body: "The incisionless, FDA-cleared procedure works — the holdup is getting insurers to cover it, even as it clears tremor, prostate cancer, and bone-metastasis pain.",
    gradient: "linear-gradient(135deg,#16252a,#10141b)",
    url: "https://www.statnews.com/2024/05/29/focused-ultrasound-uterine-fibroids/",
  },
  {
    id: "tsy",
    cat: "Finance",
    title: "Vanguard Favors Treasuries as 10-Year Yields Near Range Top",
    shortTitle: "Vanguard Favors Treasuries as Yields Near Range Top",
    src: "BLOOMBERG · 4h",
    srcLong: "BLOOMBERG · 4h AGO · 5 MIN READ",
    body: "Duration is being treated as portfolio insurance again — Vanguard's fixed-income team is holding a long-duration bias with 10-year yields near the top of its expected range.",
    gradient: "linear-gradient(135deg,#1d2330,#10141b)",
    url: "https://www.bloomberg.com/news/articles/2026-05-18/vanguard-favors-treasuries-as-10-year-yields-near-range-top",
  },
  {
    id: "ondevice",
    cat: "Tech",
    title: "Big Tech's AI Hardware Bet: Worthless in Three Years?",
    shortTitle: "Big Tech's AI Hardware Bet: Worthless in 3 Years?",
    src: "FORTUNE · 7h",
    srcLong: "FORTUNE · 7h AGO · 8 MIN READ",
    body: "Hyperscalers are pouring hundreds of billions into data-center hardware that depreciates fast as model architectures shift — the dirty secret behind the AI arms race.",
    gradient: "linear-gradient(135deg,#1a2433,#10141b)",
    url: "https://fortune.com/2026/04/15/data-centers-hyperscalers-spending-billions-on-hardware-thats-worthless-in-3-years/",
    size: "wide",
  },
  {
    id: "semis",
    cat: "Finance",
    title: "AI Boom: Big Tech Capex Now Seen Topping $1 Trillion in 2027",
    shortTitle: "Big Tech Capex Seen Topping $1T in 2027",
    src: "CNBC · 1d",
    srcLong: "CNBC · 1d AGO · 7 MIN READ",
    body: "The bull case rests on data-center capex staying durable for years to come; the bear case is that AI services generate a fraction of what's being spent on infrastructure.",
    gradient: "linear-gradient(135deg,#22262f,#10141b)",
    url: "https://www.cnbc.com/2026/04/30/ai-boom-big-tech-capital-expenditures-now-seen-topping-1-trillion-in-2027-.html",
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

// YouTube/Vimeo links are the only "real video" signal available for feed
// items — RssItem (src/lib/feeds/rss.ts) carries no enclosure mime-type, so a
// URL-pattern check is the only reliable detector short of fetching each link.
// Hardcoded STORIES instead carry an explicit `video` flag.
const VIDEO_URL_RE = /(?:youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d)/i;

function isVideoStory(s: Story): boolean {
  return !!s.video || VIDEO_URL_RE.test(s.url);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "< 1h";
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Route every preview image through our own /api/og-image proxy so CORS / 403
// hotlink-protection on the upstream host can't silently break the thumbnail.
function proxyImage(url: string): string {
  return `/api/og-image?url=${encodeURIComponent(url)}`;
}

// Scrape an article page for its og:image when the feed item carried no image.
async function scrapeOgImage(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/og-image?url=${encodeURIComponent(pageUrl)}&meta=1`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.image === "string" ? data.image : null;
  } catch {
    return null;
  }
}

// Preview image overlaid on a card/reader whose parent already paints a gradient.
// Routed through /api/og-image (proxy mode) to dodge CORS / 403 hotlink failures;
// on any load error the <img> removes itself, revealing the gradient underneath.
function PreviewImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxyImage(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        zIndex: 0,
      }}
    />
  );
}

export function BriefingModule() {
  const { open: openInApp } = useWebViewer();
  const { toast } = useToast();
  const [active, setActive] = useState<Set<string>>(
    () => new Set(CHIPS.filter((c) => c.on).map((c) => c.f)),
  );
  const [readerId, setReaderId] = useState<string>(STORIES[0].id);
  const { savedItems: saved, feeds: savedFeeds, loading: briefingLoading, loadError: briefingLoadError, signedIn, refresh: refreshBriefing, addSavedItem, removeSavedItem, addFeed, removeFeed } = useBriefing();
  const [showSaved, setShowSaved] = useState(false);
  const [feedbarQuery, setFeedbarQuery] = useState("");

  const [feedSearchOpen, setFeedSearchOpen] = useState(false);
  const [feedQuery, setFeedQuery] = useState("");
  const [feedSearching, setFeedSearching] = useState(false);
  const [feedResults, setFeedResults] = useState<Array<{name: string; url: string; description: string}>>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [feedItems, setFeedItems] = useState<Story[]>([]);
  const [feedsLoading, setFeedsLoading] = useState(false);
  const [feedLoadError, setFeedLoadError] = useState<string | null>(null);
  // og:image scraped per curated story (they ship with a gradient only) so the
  // featured cards get a real preview image, same as RSS items do.
  const [storyImages, setStoryImages] = useState<Record<string, string>>({});
  const feedSearchDialogRef = useRef<HTMLDivElement>(null);
  const sourcesDialogRef = useRef<HTMLDivElement>(null);

  // Escape-to-close + focus trap for Feed Search modal
  useEffect(() => {
    if (!feedSearchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFeedSearchOpen(false); };
    document.addEventListener("keydown", onKey);
    const el = feedSearchDialogRef.current;
    const sel = 'button,input,textarea,select,[href],[tabindex]:not([tabindex="-1"])';
    const nodes = [...(el?.querySelectorAll<HTMLElement>(sel) ?? [])];
    nodes[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus();
      }
    };
    el?.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", onKey); el?.removeEventListener("keydown", trap); };
  }, [feedSearchOpen]);

  // Escape-to-close + focus trap for Manage Sources modal
  useEffect(() => {
    if (!sourcesOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSourcesOpen(false); };
    document.addEventListener("keydown", onKey);
    const el = sourcesDialogRef.current;
    const sel = 'button,input,textarea,select,[href],[tabindex]:not([tabindex="-1"])';
    const nodes = [...(el?.querySelectorAll<HTMLElement>(sel) ?? [])];
    nodes[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus();
      }
    };
    el?.addEventListener("keydown", trap);
    return () => { document.removeEventListener("keydown", onKey); el?.removeEventListener("keydown", trap); };
  }, [sourcesOpen]);

  // Load real RSS items (with preview images) from the saved feeds.
  const loadFeeds = useCallback((opts?: { silent?: boolean }) => {
    if (savedFeeds.length === 0) { setFeedItems([]); return; }
    if (!opts?.silent) setFeedsLoading(true);
    setFeedLoadError(null);
    fetch("/api/feeds/cached", {
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

        // For items the feed gave no image, scrape the article's og:image in the
        // background and patch it in. Failures are silent (gradient stays).
        items
          .filter((it) => !it.image && it.url)
          .forEach((it) => {
            void scrapeOgImage(it.url).then((img) => {
              if (!img) return;
              setFeedItems((prev) =>
                prev.map((p) => (p.id === it.id && !p.image ? { ...p, image: img } : p)),
              );
            });
          });
      })
      .catch(() => {
        setFeedLoadError("Live feeds could not be refreshed. Showing curated stories only.");
      })
      .finally(() => { if (!opts?.silent) setFeedsLoading(false); });
  }, [savedFeeds]);

  // Scrape an og:image for each curated story once on mount (failures stay
  // silent — the gradient remains). Runs in parallel; patches as each resolves.
  useEffect(() => {
    let alive = true;
    STORIES.filter((s) => !s.image && s.url).forEach((s) => {
      void scrapeOgImage(s.url).then((img) => {
        if (alive && img) setStoryImages((prev) => (prev[s.id] ? prev : { ...prev, [s.id]: img }));
      });
    });
    return () => { alive = false; };
  }, []);

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

  const toggleSave = async (s: Story, type: "read" | "watch" = "read") => {
    const already = saved.some((x) => x.url === s.url);
    if (already) {
      const result = await removeSavedItem(s.url);
      if (result.error) {
        toast(result.error, "error", "Briefing");
        return;
      }
      toast("Removed from saved", "success", "Briefing");
    } else {
      const result = await addSavedItem({ title: s.shortTitle, url: s.url, type });
      if (result.error) {
        toast(result.error, "error", "Briefing");
        return;
      }
      toast(`Saved for ${type === "watch" ? "later" : "reading"}`, "success", "Briefing");
    }
  };

  const searchFeeds = async (queryOverride?: string) => {
    const q = (queryOverride ?? feedQuery).trim();
    if (!q) return;
    setFeedQuery(q);
    setFeedSearching(true);
    try {
      const res = await fetch("/api/briefing/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (res.ok) {
        const data = await res.json();
        setFeedResults(data.feeds ?? []);
        if (data.error) toast("Feed search is temporarily unavailable — try again shortly.", "warn", "Briefing");
      } else {
        setFeedResults([]);
        toast("Feed search failed — try again.", "error", "Briefing");
      }
    } catch {
      setFeedResults([]);
      toast("Couldn't reach feed search — check your connection.", "error", "Briefing");
    } finally {
      setFeedSearching(false);
    }
  };

  const saveFeed = async (feed: {name: string; url: string}) => {
    const result = await addFeed(feed);
    if (result.error) {
      toast(result.error, "error", "Briefing");
      return;
    }
    toast(`${feed.name} added to sources.`, "success", "Briefing");
  };

  const deleteSavedItem = async (item: { title: string; url: string }) => {
    const result = await removeSavedItem(item.url);
    if (result.error) {
      toast(result.error, "error", "Briefing");
      return;
    }
    toast(`${item.title} removed from saved.`, "info", "Briefing");
  };

  const deleteFeed = async (feed: { name: string; url: string }) => {
    if (!window.confirm(`Remove ${feed.name} from Briefing sources?`)) return;
    const result = await removeFeed(feed.url);
    if (result.error) {
      toast(result.error, "error", "Briefing");
      return;
    }
    toast(`${feed.name} removed from sources.`, "info", "Briefing");
  };

  const curatedStories = STORIES.map((s) => ({
    ...s,
    src: s.src.startsWith("Curated ·") ? s.src : `Curated · ${s.src}`,
    srcLong: s.srcLong.startsWith("Curated ·") ? s.srcLong : `Curated · ${s.srcLong}`,
  }));

  const allStories = [
    ...curatedStories.map((s) => (s.image ? s : { ...s, image: storyImages[s.id] ?? null })),
    ...feedItems,
  ];
  const visible = active.has("all")
    ? allStories
    : allStories.filter((s) => active.has(CAT_TO_FILTER[s.cat] ?? "feed") || feedItems.some((fi) => fi.id === s.id));

  const reader = allStories.find((s) => s.id === readerId) ?? STORIES[0];
  const readerIsVideo = isVideoStory(reader);

  // Stats derived purely from already-loaded state (no new fetches). "Sync"
  // reflects connection state honestly: signed-out users only see the curated
  // sample stories, so it reads "Sample" (muted) rather than implying live data.
  const heroStats: { label: string; value: string; tone: HeroStatTone; hint?: string }[] = useMemo(
    () => [
      { label: "Saved", value: String(saved.length), tone: saved.length > 0 ? "accent" : "default" },
      { label: "Sources", value: String(savedFeeds.length), tone: savedFeeds.length > 0 ? "accent" : "default" },
      {
        label: "Live stories",
        value: String(feedItems.length),
        tone: feedLoadError ? "warn" : feedItems.length > 0 ? "success" : "default",
        hint: feedLoadError ? "refresh failed" : undefined,
      },
      { label: "Sync", value: signedIn ? "On" : "Sample", tone: signedIn ? "success" : "muted" },
    ],
    [saved.length, savedFeeds.length, feedItems.length, feedLoadError, signedIn],
  );

  return (
    <>
      <ModuleInteractiveHero
        compact
        eyebrow="Research · Briefing"
        title="Briefing"
        subtitle="Curated stories plus live headlines from the RSS feeds you follow."
        loading={briefingLoading && saved.length === 0 && savedFeeds.length === 0}
        stats={heroStats}
        actions={[
          {
            label: feedsLoading ? "Refreshing…" : "Refresh feeds",
            onClick: () => loadFeeds(),
            disabled: feedsLoading || savedFeeds.length === 0,
            primary: true,
          },
          { label: "Add feed", onClick: () => setFeedSearchOpen(true) },
        ]}
      />
      {!signedIn && !briefingLoading && (
        <StatusCallout kind="info" title="Sign in to sync Briefing">
          Curated stories are available now. Sign in to save articles, add RSS sources, and sync across devices.
        </StatusCallout>
      )}
      {briefingLoadError && (
        <StatusCallout kind="error" title="Briefing sync failed">
          {briefingLoadError}{" "}
          <button type="button" className="feed-manage" onClick={() => void refreshBriefing()}>Retry</button>
        </StatusCallout>
      )}
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
      {feedLoadError && (
        <StatusCallout kind="info" title="Live feeds unavailable">{feedLoadError}</StatusCallout>
      )}
      <div className="feedbar">
        <div className="feedbar-in">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
          <input
            value={feedbarQuery}
            onChange={(e) => setFeedbarQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && feedbarQuery.trim()) {
                setFeedSearchOpen(true);
                void searchFeeds(feedbarQuery);
              }
            }}
            placeholder="Describe a topic, source, or feed to follow — e.g. 'neurosurgery RCTs', 'Nigerian football', a site URL…"
          />
          <button
            type="button"
            className="feed-go"
            onClick={() => {
              setFeedSearchOpen(true);
              if (feedbarQuery.trim()) void searchFeeds(feedbarQuery);
            }}
          >
            ✦ Find Feeds
          </button>
        </div>
        <button type="button" className="feed-manage" onClick={() => setSourcesOpen(true)}>Manage Sources</button>
        <button type="button" className="feed-manage" onClick={() => loadFeeds()} disabled={feedsLoading || savedFeeds.length === 0}>
          {feedsLoading ? "Refreshing…" : "Refresh feeds"}
        </button>
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
        {readerIsVideo ? (
          <div
            className="r-media"
            style={reader.gradient ? { background: reader.gradient } : undefined}
          >
            {reader.image && (
              <PreviewImage src={reader.image} alt={reader.shortTitle} />
            )}
            <div className="play" onClick={() => openInApp(reader.url, reader.shortTitle)} style={{ cursor: "pointer", position: "relative", zIndex: 1 }} title="Open in app" />
            <div className="scrub">
              <span>02:14</span>
              <div className="bar" />
              <span>11:38</span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="r-art-header"
            onClick={() => openInApp(reader.url, reader.shortTitle)}
            title="Open in app"
          >
            <span className="r-art-source">{reader.src}</span>
            <span className="r-art-open">Open in app →</span>
          </button>
        )}
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
              {readerIsVideo ? "Watch in-app →" : "Read in-app →"}
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
              style={{ fontSize: 11, color: saved.some((x) => x.url === reader.url) ? "var(--gold)" : undefined }}
              onClick={() => toggleSave(reader, readerIsVideo ? "watch" : "read")}
              title={saved.some((x) => x.url === reader.url) ? "Remove from saved" : "Save for later"}
            >
              {saved.some((x) => x.url === reader.url) ? "★ Saved" : "☆ Save"}
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
                  <button type="button" className="feed-manage" style={{ fontSize: 10.5 }} onClick={() => void deleteSavedItem(item)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Feed Search Modal */}
      {feedSearchOpen && (
        <div role="dialog" aria-modal="true" aria-label="Find Feeds" style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setFeedSearchOpen(false)}>
          <div ref={feedSearchDialogRef} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--rl)", padding: 24, width: "min(540px,92vw)", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--narrow)", fontWeight: 600, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--ink-2)" }}>Find Feeds</span>
              <button type="button" onClick={() => setFeedSearchOpen(false)} aria-label="Close" style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
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
        <div role="dialog" aria-modal="true" aria-label="Your Sources" style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setSourcesOpen(false)}>
          <div ref={sourcesDialogRef} style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "var(--rl)", padding: 24, width: "min(480px,92vw)", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <span style={{ fontFamily: "var(--narrow)", fontWeight: 600, fontSize: 12, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--ink-2)" }}>Your Sources ({savedFeeds.length})</span>
              <button type="button" onClick={() => setSourcesOpen(false)} aria-label="Close" style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>
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
                    <button type="button" className="feed-manage" style={{ fontSize: 10.5, flexShrink: 0 }} onClick={() => void deleteFeed(f)}>Remove</button>
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
            className={`ncard${isVideoStory(s) ? " video" : ""}${s.size === "big" ? " big" : ""}${s.size === "wide" ? " wide" : ""}`}
            onClick={() => setReaderId(s.id)}
            onDoubleClick={() => openInApp(s.url, s.shortTitle)}
            title={`Click to preview · Double-click to read in-app`}
          >
            <div
              className="thumb"
              style={{ background: s.gradient }}
            >
              {s.image && <PreviewImage src={s.image} alt={s.shortTitle} />}
              <div className="nc-cat">{s.cat}</div>
              {isVideoStory(s) && (
                <div className="play">
                  <span />
                </div>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleSave(s, isVideoStory(s) ? "watch" : "read"); }}
                style={{ position: "absolute", top: 7, right: 7, background: "rgba(7,8,11,.55)", border: "none", borderRadius: 3, width: 24, height: 24, display: "grid", placeItems: "center", cursor: "pointer", color: saved.some((x) => x.url === s.url) ? "var(--gold)" : "rgba(193,196,199,.7)", fontSize: 12 }}
                title={saved.some((x) => x.url === s.url) ? "Remove from saved" : "Save for later"}
              >
                {saved.some((x) => x.url === s.url) ? "★" : "☆"}
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
