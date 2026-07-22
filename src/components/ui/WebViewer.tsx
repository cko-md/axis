"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import { isAxisDesktop, openDesktopBrowser } from "@/lib/desktop-browser";
import { createClient } from "@/lib/supabase/client";
import { pullSetting, pushSetting } from "@/lib/settings/localMirror";

const FAVS_KEY = "axis-wv-favorites";
const FAVS_SETTING_KEY = "webviewer.favorites";
type Fav = { url: string; title: string };
function isFavArray(v: unknown): v is Fav[] {
  return Array.isArray(v) && v.every(
    (f) => f && typeof f === "object"
      && typeof (f as Fav).url === "string"
      && typeof (f as Fav).title === "string",
  );
}
type Tab = { id: string; url: string; title: string; back: string[]; forward: string[] };
type ReaderData = {
  url: string;
  title: string;
  html: string;
  excerpt?: string | null;
  byline?: string | null;
  siteName?: string | null;
};

function loadFavs(): Fav[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(FAVS_KEY) ?? "[]"); } catch { return []; }
}
function saveFavs(favs: Fav[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(FAVS_KEY, JSON.stringify(favs));
}
function uid() { return Math.random().toString(36).slice(2, 10); }

// OAuth/login hosts must open in a real browser tab — never the embedded proxy
// webview (Google forbids OAuth via embedded webviews). Mirrors OAUTH_HOSTS in
// src/app/api/proxy/route.ts.
const OAUTH_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "accounts.spotify.com",
  "appleid.apple.com",
  "www.strava.com",
  "github.com",
];
function isOAuthUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return OAUTH_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch { return false; }
}

export function WebViewer() {
  const { current, close, open } = useWebViewer();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const supabase = useMemo(() => createClient(), []);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [inputUrl, setInputUrl] = useState("");
  const [favs, setFavs] = useState<Fav[]>([]);
  const [showFavs, setShowFavs] = useState(false);
  const [captureState, setCaptureState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ok" | "blocked">("idle");
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local reader view — shown when a page cannot be usefully embedded.
  const [readerState, setReaderState] = useState<"off" | "loading" | "ok" | "error">("off");
  const [readerData, setReaderData] = useState<ReaderData | null>(null);
  const [readerError, setReaderError] = useState<string>("");
  // Why reader view was triggered — surfaced in the UI so "this site blocks
  // embedding" reads differently from "this took too long to load". Set by the
  // proxy's postMessage (server-detected) or by the client-side timeout.
  const [readerReason, setReaderReason] = useState<string>("");
  // Token guards against stale async responses landing on a newer navigation.
  const readerTokenRef = useRef(0);

  useEffect(() => {
    const local = loadFavs();
    setFavs(local);
    void (async () => {
      const remote = await pullSetting(FAVS_SETTING_KEY, isFavArray);
      if (remote) {
        saveFavs(remote);
        setFavs(remote);
      } else if (local.length) {
        pushSetting(FAVS_SETTING_KEY, local);
      }
    })();
  }, []);

  // Track whether viewer is open to avoid stale closure in event handler
  const isOpenRef = useRef(false);
  useEffect(() => { isOpenRef.current = tabs.length > 0; }, [tabs]);

  // Initialize tabs on first open; clear on close
  useEffect(() => {
    if (current && tabs.length === 0) {
      const id = uid();
      setTabs([{ id, url: current.url, title: current.title ?? "New Tab", back: [], forward: [] }]);
      setActiveTabId(id);
      setInputUrl(current.url);
    }
    if (!current) {
      setTabs([]);
      setActiveTabId("");
      setInputUrl("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const activeUrl = activeTab?.url ?? "";

  // Use a ref for addTab to keep event handler stable without stale closures
  const addTabRef = useRef<(url?: string) => void>(() => {});
  addTabRef.current = (url = "") => {
    const id = uid();
    setTabs((prev) => [...prev, { id, url, title: url ? "Loading…" : "New Tab", back: [], forward: [] }]);
    setActiveTabId(id);
    setInputUrl(url);
  };
  const addTab = useCallback((url = "") => addTabRef.current(url), []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (prev.length === 1) { close(); return []; }
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) {
        const nextTab = next[Math.min(idx, next.length - 1)];
        setActiveTabId(nextTab.id);
        setInputUrl(nextTab.url);
      }
      return next;
    });
  }, [activeTabId, close]);

  const switchTab = useCallback((id: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === id);
      if (!tab) return prev;
      setActiveTabId(id);
      setInputUrl(tab.url);
      return prev;
    });
  }, []);

  const navigate = useCallback((url: string) => {
    // OAuth/login pages must never load in the embedded proxy — open a real tab
    if (url && isOAuthUrl(url)) {
      window.open(url, "_blank", "noopener");
      return;
    }
    // On desktop, hand the destination to the native browser rather than
    // loading it into the proxy iframe. Reached from the address bar, the
    // favorites bar, the start page, and the proxy's own navigation messages —
    // none of which previously consulted the bridge at all.
    if (isAxisDesktop()) {
      void openDesktopBrowser(url).then((result) => {
        if (!result.handled) setInputUrl(url);
      });
      return;
    }
    setInputUrl(url);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, url, back: t.url ? [...t.back, t.url] : t.back, forward: [] }
          : t
      )
    );
    setReloadNonce((value) => value + 1);
    // New navigation supersedes any in-flight reader fetch and clears reader UI.
    readerTokenRef.current += 1;
    setReaderState("off");
    setReaderData(null);
    setReaderError("");
    setReaderReason("");
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    if (url) {
      setLoadState("loading");
      loadTimerRef.current = setTimeout(() => setLoadState("blocked"), 6000);
    } else {
      setLoadState("idle");
    }
  }, [activeTabId]);

  // Fetch clean readable content through the local Mozilla Readability route.
  const openReader = useCallback(async (rawUrl?: string, reason?: string) => {
    const url = (rawUrl ?? activeUrl).trim();
    if (!url) return;
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    const token = ++readerTokenRef.current;
    setReaderState("loading");
    setReaderError("");
    setReaderData(null);
    setReaderReason(reason ?? "");
    try {
      const res = await fetch(`/api/reader/extract?url=${encodeURIComponent(url)}`);
      if (token !== readerTokenRef.current) return; // superseded
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setReaderError(body?.error || `Reader unavailable (${res.status})`);
        setReaderState("error");
        return;
      }
      const data = (await res.json()) as ReaderData;
      if (token !== readerTokenRef.current) return; // superseded
      setReaderData(data);
      setReaderState("ok");
    } catch (err) {
      if (token !== readerTokenRef.current) return;
      setReaderError(err instanceof Error ? err.message : "Reader failed");
      setReaderState("error");
    }
  }, [activeUrl]);

  // Handle navigation + reader-handoff messages posted by the proxy's injected script
  useEffect(() => {
    function onProxyMsg(e: MessageEvent) {
      // The frame deliberately has an opaque origin (no allow-same-origin).
      // Trust only messages from the exact iframe window, never another tab,
      // popup, or page in the parent application.
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'proxy-navigate') {
        const url = e.data.url as string;
        if (url) navigate(url);
        return;
      }
      if (e.data?.type === 'proxy-reader') {
        const url = e.data.url as string;
        const reason = typeof e.data.reason === 'string' ? e.data.reason : undefined;
        if (url) void openReader(url, reason);
      }
    }
    window.addEventListener('message', onProxyMsg);
    return () => window.removeEventListener('message', onProxyMsg);
  }, [navigate, openReader]);

  // Fallback: if the iframe never settles within the timeout (a silent JS
  // framebust the server-side header check didn't catch), offer reader view
  // instead of leaving the user staring at a blank/blocked frame.
  useEffect(() => {
    if (loadState === "blocked" && readerState === "off") {
      void openReader(undefined, "This page didn't finish loading in time — it may be blocking embedding silently");
    }
  }, [loadState, readerState, openReader]);

  const goBack = useCallback(() => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === activeTabId);
      if (!tab || !tab.back.length) return prev;
      const url = tab.back[tab.back.length - 1];
      setInputUrl(url);
      setReloadNonce((value) => value + 1);
      return prev.map((t) =>
        t.id === activeTabId
          ? { ...t, url, back: t.back.slice(0, -1), forward: [t.url, ...t.forward] }
          : t
      );
    });
  }, [activeTabId]);

  const goForward = useCallback(() => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === activeTabId);
      if (!tab || !tab.forward.length) return prev;
      const url = tab.forward[0];
      setInputUrl(url);
      setReloadNonce((value) => value + 1);
      return prev.map((t) =>
        t.id === activeTabId
          ? { ...t, url, back: [...t.back, t.url], forward: t.forward.slice(1) }
          : t
      );
    });
  }, [activeTabId]);

  const isFaved = favs.some((f) => f.url === activeUrl);
  const toggleFav = useCallback(() => {
    const title = activeTab?.title ?? activeUrl;
    const next = isFaved
      ? favs.filter((f) => f.url !== activeUrl)
      : [...favs, { url: activeUrl, title }];
    setFavs(next);
    saveFavs(next);
    pushSetting(FAVS_SETTING_KEY, next);
  }, [favs, isFaved, activeUrl, activeTab]);

  const captureToNotes = useCallback(async () => {
    if (!activeUrl) return;
    setCaptureState("saving");
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw authError ?? new Error("Sign in to save this page.");
      const title = (activeTab?.title && activeTab.title !== "Loading…" && activeTab.title !== "New Tab")
        ? activeTab.title : activeUrl;
      const timestamp = new Date().toLocaleString();
      const body = `<p><a href="${activeUrl}">${activeUrl}</a></p><p style="font-size:12px;color:#888;"><em>Captured from WebViewer · ${timestamp}</em></p>`;
      const { error } = await supabase.from("notes").insert({
        user_id: user.id,
        title: title.slice(0, 120),
        body,
        folder: "All Notes",
        tags: ["web-capture"],
        sort_order: 0,
      });
      if (error) throw error;
      setCaptureState("saved");
    } catch {
      setCaptureState("error");
    }
    setTimeout(() => setCaptureState("idle"), 3000);
  }, [supabase, activeUrl, activeTab]);

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, close]);

  // Global link interceptor — capture-phase click on absolute external links
  useEffect(() => {
    function intercept(e: MouseEvent) {
      const anchor = (e.target as Element).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      const target = anchor.getAttribute("target");
      if (!href || href.startsWith("#") || href.startsWith("javascript")) return;
      if (target === "_blank" || href.startsWith("http://") || href.startsWith("https://")) {
        if (!href.startsWith("http://") && !href.startsWith("https://")) return;
        e.preventDefault();
        e.stopPropagation();
        // OAuth/login links bypass the in-app viewer and open a real browser tab
        if (isOAuthUrl(href)) {
          window.open(href, "_blank", "noopener");
          return;
        }
        const title = anchor.textContent?.trim() || undefined;
        window.dispatchEvent(new CustomEvent("axis:open-url", { detail: { url: href, title } }));
      }
    }
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, []);

  // If viewer is open: add a new tab. If closed: open the viewer.
  useEffect(() => {
    function onOpenUrl(e: Event) {
      const { url, title } = (e as CustomEvent<{ url: string; title?: string }>).detail;
      // Always go through the provider's `open`, which consults the Electron
      // bridge first. Calling addTab directly meant that once the iframe modal
      // was showing for any reason, every later link permanently bypassed the
      // native browser on desktop.
      if (isOpenRef.current && !isAxisDesktop()) {
        addTabRef.current(url);
      } else {
        open(url, title);
      }
    }
    window.addEventListener("axis:open-url", onOpenUrl);
    return () => window.removeEventListener("axis:open-url", onOpenUrl);
  }, [open]);

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const raw = inputUrl.trim();
    if (!raw) return;
    const looksLikeUrl = /^https?:\/\//.test(raw) || (raw.includes(".") && !raw.includes(" "));
    if (!looksLikeUrl) {
      // Search queries can't be embedded — every major engine framebusts, so an
      // in-frame Google search just falls to a garbled reader view. Open the
      // search in the user's real browser instead of pretending it works here.
      window.open(`https://www.google.com/search?q=${encodeURIComponent(raw)}`, "_blank", "noopener");
      return;
    }
    const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
    navigate(url);
    setShowFavs(false);
  }, [inputUrl, navigate]);

  if (!current || tabs.length === 0) return null;

  const canBack = (activeTab?.back.length ?? 0) > 0;
  const canForward = (activeTab?.forward.length ?? 0) > 0;

  return (
    <div className="wv-overlay" role="dialog" aria-modal="true" aria-label="In-platform browser">
      <div className="wv-modal">

        {/* Tab bar */}
        <div className="wv-tabbar">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`wv-tab${tab.id === activeTabId ? " wv-tab-active" : ""}`}
              onClick={() => switchTab(tab.id)}
              title={tab.url}
            >
              <span className="wv-tab-title">
                {tab.title === "New Tab" || !tab.title || tab.title === "Loading…"
                  ? (tab.url ? tab.url.replace(/^https?:\/\//, "").slice(0, 22) : "New Tab")
                  : tab.title.slice(0, 22)}
              </span>
              <span
                className="wv-tab-x"
                role="button"
                tabIndex={0}
                aria-label={`Close tab: ${tab.title}`}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
                title="Close tab"
              >×</span>
            </button>
          ))}
          <button type="button" className="wv-tab-new" onClick={() => addTab()} title="New tab" aria-label="New tab">+</button>
        </div>

        {/* Toolbar */}
        <div className="wv-toolbar">
          <div className="wv-nav">
            <button type="button" className="wv-navbtn" title="Back" onClick={goBack} disabled={!canBack} style={{ opacity: canBack ? 1 : 0.3 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="10,3 5,8 10,13" />
              </svg>
            </button>
            <button type="button" className="wv-navbtn" title="Forward" onClick={goForward} disabled={!canForward} style={{ opacity: canForward ? 1 : 0.3 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6,3 11,8 6,13" />
              </svg>
            </button>
            <button type="button" className="wv-navbtn" title="Reload" onClick={() => {
              if (!activeUrl) return;
              setLoadState("loading");
              setReloadNonce((value) => value + 1);
            }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 2.5 A6.5 6.5 0 1 1 6.5 1.5"/><polyline points="13.5,2.5 13.5,6 10,6"/>
              </svg>
            </button>
            <button type="button" className="wv-navbtn" title={showFavs ? "Hide bookmarks" : "Bookmarks"} onClick={() => setShowFavs((s) => !s)} style={{ color: showFavs ? "var(--gold)" : undefined }}>
              <svg viewBox="0 0 16 16" fill={showFavs ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 2h10v13l-5-3-5 3z"/>
              </svg>
            </button>
          </div>

          <form className="wv-urlbar" onSubmit={handleUrlSubmit}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="14" y2="14"/>
            </svg>
            <input
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onFocus={(e) => e.target.select()}
              placeholder="Search or enter address"
              spellCheck={false}
              autoComplete="off"
            />
          </form>

          <div className="wv-actions">
            <button
              type="button"
              className="wv-navbtn"
              title={captureState === "saved" ? "Saved to Notes" : captureState === "error" ? "Could not save to Notes" : "Save page to Notes"}
              aria-label={captureState === "error" ? "Could not save page to Notes; try again" : "Save page to Notes"}
              disabled={captureState === "saving"}
              onClick={captureToNotes}
              style={{ color: captureState === "saved" ? "var(--sage)" : captureState === "error" ? "var(--clay-2)" : undefined }}
            >
              {captureState === "saved" ? (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3,8 6.5,12 13,4"/>
                </svg>
              ) : captureState === "error" ? (
                <span aria-hidden>!</span>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="5" y1="6" x2="11" y2="6"/><line x1="5" y1="9" x2="9" y2="9"/>
                </svg>
              )}
            </button>
            <button type="button" className="wv-navbtn" title={isFaved ? "Remove bookmark" : "Bookmark this page"} onClick={toggleFav} style={{ color: isFaved ? "var(--gold)" : undefined }}>
              <svg viewBox="0 0 16 16" fill={isFaved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="8,1 10,6 15,6 11,9.5 12.5,15 8,11.5 3.5,15 5,9.5 1,6 6,6"/>
              </svg>
            </button>
            <button type="button" className="wv-navbtn" title="Open in browser" onClick={() => window.open(activeUrl, "_blank", "noopener")}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3H3v10h10v-3"/><polyline points="9,3 13,3 13,7"/><line x1="9" y1="7" x2="13" y2="3"/>
              </svg>
            </button>
            <button type="button" className="wv-navbtn wv-close" title="Close" onClick={close}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Favorites bar */}
        {showFavs && (
          <div className="wv-favbar">
            {favs.length === 0 ? (
              <span className="wv-fav-empty">No bookmarks yet — star a page to save it here.</span>
            ) : (
              favs.map((f) => (
                <button key={f.url} type="button" className="wv-fav" onClick={() => { navigate(f.url); setShowFavs(false); }} title={f.url}>
                  {f.title.slice(0, 28)}{f.title.length > 28 ? "…" : ""}
                </button>
              ))
            )}
          </div>
        )}

        {/* Browser frame */}
        <div className="wv-frame-wrap">
          <iframe
            key={`${activeTabId}:${reloadNonce}`}
            ref={iframeRef}
            src={activeUrl ? `/api/proxy?url=${encodeURIComponent(activeUrl)}` : undefined}
            title={activeTab?.title ?? "Browser"}
            className="wv-frame"
            sandbox="allow-scripts allow-forms allow-popups"
            onLoad={() => {
              if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
              setLoadState("ok");
            }}
          />
          {!activeUrl && readerState === "off" && (
            <div className="wv-start">
              <div className="wv-start-mark">A<span>XIS</span> · Browser</div>
              <p className="wv-start-hint">Type a URL in the address bar to browse in-app. Plain search terms open in your default browser.</p>
              {favs.length > 0 && (
                <div className="wv-start-favs">
                  {favs.map((f) => (
                    <button key={f.url} type="button" className="wv-start-fav" onClick={() => navigate(f.url)} title={f.url}>
                      <span className="wv-start-fav-t">{f.title.slice(0, 26)}{f.title.length > 26 ? "…" : ""}</span>
                      <span className="wv-start-fav-u">{f.url.replace(/^https?:\/\//, "").slice(0, 32)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {loadState === "blocked" && readerState === "off" && (
            <div className="wv-blocked-hint">
              <span>This page is taking too long to load — it may be blocking embedding.</span>
              <button type="button" onClick={() => void openReader()}>Open reader view →</button>
              <button type="button" onClick={() => window.open(activeUrl, "_blank", "noopener")}>Open in browser →</button>
            </div>
          )}

          {(readerState === "loading" || readerState === "ok" || readerState === "error") && (
            <div className="wv-reader">
              <div className="wv-reader-bar">
                <div className="wv-reader-badge-group">
                  <span className="wv-reader-badge">Reader view · local extraction</span>
                  {readerReason && <span className="wv-reader-reason">{readerReason}</span>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="wv-navbtn" onClick={() => window.open(activeUrl, "_blank", "noopener")}>
                    Open original →
                  </button>
                  <button
                    type="button"
                    className="wv-navbtn"
                    onClick={() => { setReaderState("off"); setReaderData(null); setReaderError(""); setReaderReason(""); }}
                  >
                    ✕ Close reader
                  </button>
                </div>
              </div>

              {readerState === "loading" && (
                <p className="wv-reader-status">Extracting readable content…</p>
              )}
              {readerState === "error" && (
                <div className="wv-reader-error">
                  <p>{readerError || "Could not extract this page."}</p>
                  <p className="wv-reader-error-sub">Reader view couldn&apos;t render this either — your best option is opening it in a real browser tab.</p>
                  <button type="button" className="wv-navbtn" onClick={() => window.open(activeUrl, "_blank", "noopener")}>
                    Open in browser instead →
                  </button>
                </div>
              )}
              {readerState === "ok" && readerData && (
                <article className="wv-reader-article">
                  <h1 className="wv-reader-title">
                    {readerData.title}
                  </h1>
                  {(readerData.byline || readerData.siteName) && (
                    <p className="wv-reader-byline">
                      {[readerData.byline, readerData.siteName].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <div
                    className="wv-reader-content"
                    dangerouslySetInnerHTML={{ __html: readerData.html }}
                  />
                </article>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
