"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSpotify } from "@/components/spotify/SpotifyProvider";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import styles from "./vault.module.css";

const DEFAULT_EMBED = "https://open.spotify.com/embed/playlist/37i9dQZF1DWZeKCadgRdKQ?utm_source=axis";

/** open.spotify.com/{playlist|album|track|artist|episode|show}/{id} → embed URL */
function toEmbedUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.hostname !== "open.spotify.com") return null;
    const [type, id] = url.pathname.split("/").filter(Boolean);
    if (!id || !["playlist", "album", "track", "artist", "episode", "show"].includes(type)) return null;
    return `https://open.spotify.com/embed/${type}/${id}?utm_source=axis`;
  } catch {
    return null;
  }
}

function fmt(ms: number): string {
  if (!ms || ms < 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// ── decorative fallback (signed-out / unconfigured) — the original sample crate room ──
const SAMPLE_SPINES = [
  { text: "DEEP WORK · STEEL", color: "#5b6470" },
  { text: "LAGOS NIGHTS", color: "#8a5a3a" },
  { text: "BLUE NOTE, LATE", color: "#3d5166" },
  { text: "TEMPO · LONG RUN", color: "#3f5c50" },
];
const SAMPLE_CRATES = [
  { title: "Deep Work · Steel", meta: "42 trk · 2h51", art: "linear-gradient(135deg,#4a5058,#2a2e35)" },
  { title: "Lagos Nights", meta: "30 trk · 1h58", art: "linear-gradient(135deg,#3a3f48,#22262c)" },
  { title: "Blue Note, Late", meta: "26 trk · 2h12", art: "linear-gradient(135deg,#454a52,#282c32)" },
];

const SPINE_COLORS = ["#5b6470", "#8a5a3a", "#3d5166", "#3f5c50", "#6a5470", "#7a6440", "#456056", "#52607a"];

type TrackLite = { id: string; uri: string; name: string; artists: string; album: string; art: string | null; durationMs: number };
type ArtistLite = { id: string; uri: string; name: string; art: string | null; genres?: string[] };
type CrateItem = { id: string; uri: string; name: string; sub: string; art: string | null };

type LibKind = "recent" | "top-tracks" | "albums" | "playlists";
type Term = "short" | "medium" | "long";

const ICON = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  prev: "M6 6h2v12H6zm3.5 6l8.5 6V6z",
  next: "M16 6h2v12h-2zM6 18l8.5-6L6 6z",
  shuffle: "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
  repeat: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  vol: "M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12z",
};

export function VaultModule() {
  const spotify = useSpotify();
  const { toast } = useToast();
  const { connected, configured, now, liveProgressMs, playing } = spotify;

  const [link, setLink] = useState("");
  const [embedUrl, setEmbedUrl] = useState(DEFAULT_EMBED);

  // Library state
  const [kind, setKind] = useState<LibKind>("recent");
  const [term, setTerm] = useState<Term>("medium");
  const [crates, setCrates] = useState<CrateItem[]>([]);
  const [artists, setArtists] = useState<ArtistLite[]>([]);
  const [loadingLib, setLoadingLib] = useState(false);

  const loadLink = () => {
    const embed = toEmbedUrl(link);
    if (!embed) {
      toast("Paste a Spotify link like open.spotify.com/playlist/…", "warn", "Vault");
      return;
    }
    setEmbedUrl(embed);
    setLink("");
    toast("Loaded into the player.", "success", "Vault");
  };

  // ── fetch top artists for the spine shelf (always, when connected) ──
  useEffect(() => {
    if (!connected) {
      setArtists([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/spotify/library?kind=top-artists&term=${term}`, { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && data.connected) setArtists(data.items ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, term]);

  // ── fetch crate content based on the selected tab ──
  useEffect(() => {
    if (!connected) {
      setCrates([]);
      return;
    }
    let cancelled = false;
    setLoadingLib(true);
    (async () => {
      try {
        const qs = kind === "top-tracks" ? `kind=top-tracks&term=${term}` : `kind=${kind}`;
        const res = await fetch(`/api/spotify/library?${qs}`, { cache: "no-store" });
        const data = await res.json();
        if (cancelled || !data.connected) return;
        const items: CrateItem[] = (data.items ?? []).map(
          (i: TrackLite & { artists?: string; total?: number; owner?: string }) => {
            if (kind === "albums") {
              return { id: i.id, uri: i.uri, name: i.name, sub: `${i.artists ?? ""}`, art: i.art ?? null };
            }
            if (kind === "playlists") {
              return { id: i.id, uri: i.uri, name: i.name, sub: `${i.total ?? 0} trk · ${i.owner ?? ""}`, art: i.art ?? null };
            }
            return { id: i.id, uri: i.uri, name: i.name, sub: i.artists ?? "", art: i.art ?? null };
          },
        );
        setCrates(items);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoadingLib(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, kind, term]);

  // ── transport handlers ──
  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => spotify.seek(Number(e.target.value));
  const onVol = (e: React.ChangeEvent<HTMLInputElement>) => spotify.setVolume(Number(e.target.value));

  const playCrate = useCallback(
    async (item: CrateItem) => {
      const res = await spotify.queue(item.uri).then(() => null).catch(() => null);
      void res;
      // Albums/playlists/tracks: start playback at that context/track.
      await spotify.playUris([item.uri]);
      toast(`Playing ${item.name}`, "success", "Vault");
    },
    [spotify, toast],
  );

  // ── search modal ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [tracks, setTracks] = useState<TrackLite[]>([]);

  const runSearch = useCallback(async () => {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}&type=track`, { cache: "no-store" });
      const data = await res.json();
      setTracks(data.tracks ?? []);
    } catch {
      toast("Search failed.", "error", "Vault");
    } finally {
      setSearching(false);
    }
  }, [q, toast]);

  const queueTrack = async (t: TrackLite) => {
    const r = await spotify.queue(t.uri);
    if (r.ok) toast(`Queued ${t.name}`, "success", "Vault");
    else toast(r.message ?? "Couldn't queue — open Spotify on a device.", "warn", "Vault");
  };
  const playTrack = async (t: TrackLite) => {
    await spotify.playUris([t.uri]);
    toast(`Playing ${t.name}`, "success", "Vault");
  };

  // ── focus playlist modal ──
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusPrompt, setFocusPrompt] = useState("");
  const [building, setBuilding] = useState(false);

  const buildFocus = useCallback(
    async (create: boolean) => {
      if (!focusPrompt.trim()) {
        toast("Describe the mood first.", "warn", "Vault");
        return;
      }
      setBuilding(true);
      try {
        const res = await fetch("/api/spotify/focus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: focusPrompt, create }),
        });
        const data = await res.json();
        if (!res.ok || !data.tracks?.length) {
          toast(data.message ?? "No matches — try a different mood.", "warn", "Vault");
          return;
        }
        if (create && data.created) {
          toast(`Created “${data.name}” · ${data.tracks.length} tracks`, "success", "Vault");
          if (data.playlistId) setEmbedUrl(`https://open.spotify.com/embed/playlist/${data.playlistId}?utm_source=axis`);
          setFocusOpen(false);
        } else {
          // Queue the suggested set onto the active device.
          await spotify.playUris(data.tracks.map((t: TrackLite) => t.uri));
          toast(`Queued ${data.tracks.length} tracks for “${data.label}”`, "success", "Vault");
          setFocusOpen(false);
        }
      } catch {
        toast("Couldn't build the playlist.", "error", "Vault");
      } finally {
        setBuilding(false);
      }
    },
    [focusPrompt, spotify, toast],
  );

  // ── derived spine list ──
  const spines = useMemo(() => {
    if (connected && artists.length) {
      return artists.slice(0, 8).map((a, i) => ({
        text: a.name.toUpperCase(),
        color: SPINE_COLORS[i % SPINE_COLORS.length],
        uri: a.uri,
      }));
    }
    return SAMPLE_SPINES.map((s) => ({ ...s, uri: undefined as string | undefined }));
  }, [connected, artists]);

  const showSample = !connected;

  const tabLabel: Record<LibKind, string> = {
    recent: "B — Recently Played",
    "top-tracks": "B — Top Tracks",
    albums: "B — Saved Albums",
    playlists: "B — Playlists",
  };

  return (
    <div className="vault-view">
      <div className="vault-room">
        <div className="vr-frame">
          <div className="vault-hero">
            <div className="vh-left">
              <div className="vh-eyebrow">Restricted · Listening Vault</div>
              <div className="vh-title">The Record Room</div>
              <div className="vh-sub">Hypermodern sleek gray — rotation and archive under lock.</div>
              <div className="vh-meta">
                <span>
                  {connected ? `${now.track ?? "Idle"}${now.artist ? ` · ${now.artist}` : ""}` : "Not connected"}
                </span>
                {playing && (
                  <span className="eq" aria-hidden>
                    <i /><i /><i /><i /><i />
                  </span>
                )}
                <span className="vh-dot">·</span>
                {connected ? (
                  <button type="button" className="pst-connect" onClick={() => void spotify.disconnect().then(() => toast("Disconnected Spotify.", "info", "Vault"))}>
                    Disconnect
                  </button>
                ) : (
                  <button type="button" className="pst-connect" onClick={spotify.connect}>
                    Connect Spotify →
                  </button>
                )}
              </div>
            </div>
            <div
              className="vault-door big"
              onClick={() => connected && spotify.togglePlay()}
              role={connected ? "button" : undefined}
              title={connected ? "Play / pause" : undefined}
            >
              <div className="vd-spokes"><i /><i /><i /></div>
              <div className="vd-hub" />
            </div>
          </div>

          {/* ── A — Rotation: top artists feed the spines ── */}
          <div className="vr-shelf-label">
            A — Rotation <span>· {connected ? "your top artists" : "spines"}</span>
          </div>
          <div className="spine-shelf">
            {spines.map((s) => (
              <div
                key={s.text}
                className="spine"
                style={{ "--sc": s.color } as React.CSSProperties}
                title={s.uri ? `Play ${s.text}` : undefined}
                onClick={() => s.uri && spotify.playUris([s.uri!])}
              >
                <span>{s.text}</span>
              </div>
            ))}
          </div>

          {/* ── library controls (connected only) ── */}
          {connected && (
            <div className={styles.libBar}>
              <div className={styles.term}>
                {(["recent", "top-tracks", "albums", "playlists"] as LibKind[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`${styles.termBtn} ${kind === k ? styles.on : ""}`}
                    onClick={() => setKind(k)}
                  >
                    {k === "recent" ? "Recent" : k === "top-tracks" ? "Top" : k === "albums" ? "Albums" : "Lists"}
                  </button>
                ))}
              </div>
              <div className={styles.libActions}>
                {(kind === "top-tracks") && (
                  <div className={styles.term}>
                    {(["short", "medium", "long"] as Term[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={`${styles.termBtn} ${term === t ? styles.on : ""}`}
                        onClick={() => setTerm(t)}
                      >
                        {t === "short" ? "4wk" : t === "medium" ? "6mo" : "yrs"}
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className={styles.iconBtn} onClick={() => setSearchOpen(true)}>
                  Search + Queue
                </button>
                <button type="button" className={styles.iconBtn} onClick={() => setFocusOpen(true)}>
                  ✦ Focus Playlist
                </button>
              </div>
            </div>
          )}

          {/* ── B — Crates ── */}
          <div className="vr-shelf-label">
            {connected ? tabLabel[kind] : "B — Crates"} <span>· {connected ? "tap to play" : "tap to load"}</span>
          </div>
          <div className="crate-row">
            {showSample &&
              SAMPLE_CRATES.map((c) => (
                <div key={c.title} className="crate">
                  <div className="cr-art" style={{ background: c.art }} />
                  <div className="cr-b">
                    <div className="cr-t">{c.title}</div>
                    <div className="cr-m">{c.meta}</div>
                  </div>
                </div>
              ))}
            {connected && loadingLib && <div className={styles.empty}>Loading your library…</div>}
            {connected && !loadingLib && crates.length === 0 && (
              <div className={styles.empty}>Nothing here yet.</div>
            )}
            {connected &&
              !loadingLib &&
              crates.map((c) => (
                <button
                  key={c.id || c.uri}
                  type="button"
                  className={`crate ${styles.crateBtn}`}
                  onClick={() => playCrate(c)}
                  title={`Play ${c.name}`}
                >
                  <div
                    className="cr-art"
                    style={{
                      backgroundImage: c.art ? `url(${c.art})` : undefined,
                      background: c.art ? undefined : "linear-gradient(135deg,#454a52,#282c32)",
                    }}
                  >
                    <span className={styles.playOverlay} aria-hidden>
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.play} /></svg>
                    </span>
                  </div>
                  <div className="cr-b">
                    <div className="cr-t">{c.name}</div>
                    <div className="cr-m">{c.sub}</div>
                  </div>
                </button>
              ))}
          </div>

          {/* ── setup-state (not connected) ── */}
          {!connected && (
            <div className={styles.setup}>
              <div className={styles.setupTitle}>Connect Spotify</div>
              <p className={styles.setupBody}>
                {configured
                  ? "Authorize Spotify to bring your rotation, recent plays, top artists, and live transport controls into the Record Room. Until then you can still load any public link below."
                  : "Spotify isn’t configured on the server yet. The Record Room runs in preview mode — load any public Spotify link below."}
              </p>
              {configured ? (
                <button type="button" className={styles.setupBtn} onClick={spotify.connect}>
                  Connect Spotify
                </button>
              ) : (
                <div className={styles.setupSteps}>
                  Set <code>SPOTIFY_CLIENT_ID</code> + <code>SPOTIFY_CLIENT_SECRET</code> in <code>.env.local</code>
                  <br />
                  Redirect URI: <code>{`${typeof window !== "undefined" ? window.location.origin : ""}/api/spotify/callback`}</code>
                </div>
              )}
            </div>
          )}

          {/* ── live transport (connected + a track present) ── */}
          {connected && now.track && (
            <div className="vault-player" style={{ marginTop: 18 }}>
              <div className={styles.transport}>
                <div
                  className={styles.npArt}
                  style={{ backgroundImage: now.art ? `url(${now.art})` : undefined }}
                />
                <div className={styles.npMeta}>
                  <div className={styles.npTitle}>{now.track}</div>
                  <div className={styles.npArtist}>
                    {now.artist}
                    {now.device ? ` · ${now.device}` : ""}
                  </div>
                </div>
                <div className={styles.ctrls}>
                  <button
                    type="button"
                    className={`${styles.ctrlBtn} ${now.shuffle ? styles.on : ""}`}
                    onClick={spotify.toggleShuffle}
                    aria-label="Shuffle"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.shuffle} /></svg>
                  </button>
                  <button type="button" className={styles.ctrlBtn} onClick={spotify.prev} aria-label="Previous">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.prev} /></svg>
                  </button>
                  <button
                    type="button"
                    className={`${styles.ctrlBtn} ${styles.play}`}
                    onClick={spotify.togglePlay}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d={playing ? ICON.pause : ICON.play} /></svg>
                  </button>
                  <button type="button" className={styles.ctrlBtn} onClick={spotify.next} aria-label="Next">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.next} /></svg>
                  </button>
                  <button
                    type="button"
                    className={`${styles.ctrlBtn} ${now.repeat !== "off" ? styles.on : ""}`}
                    onClick={spotify.cycleRepeat}
                    aria-label="Repeat"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.repeat} /></svg>
                  </button>
                </div>
              </div>
              <div className={styles.progressRow}>
                <span className={styles.time}>{fmt(liveProgressMs)}</span>
                <input
                  type="range"
                  className={styles.range}
                  min={0}
                  max={now.durationMs || 0}
                  value={Math.min(liveProgressMs, now.durationMs || 0)}
                  onChange={onSeek}
                  aria-label="Seek"
                />
                <span className={styles.time}>{fmt(now.durationMs)}</span>
                <div className={styles.vol}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.vol} /></svg>
                  <input
                    type="range"
                    className={`${styles.range} ${styles.volRange}`}
                    min={0}
                    max={100}
                    value={now.volume ?? 0}
                    onChange={onVol}
                    aria-label="Volume"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── public embed player + link loader (always available) ── */}
          <div className="vault-player">
            <iframe title="Listening Vault player" src={embedUrl} loading="lazy" />
            <div className="vp-bar">
              <input
                placeholder="Paste Spotify link…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadLink()}
              />
              <button type="button" className="sig-go" onClick={loadLink}>Load</button>
            </div>
          </div>
        </div>
      </div>

      {/* ── search modal ── */}
      <Modal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="Search · Queue"
      >
        <input
          autoFocus
          className={styles.searchInput}
          placeholder="Search tracks…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
        />
        {searching && <div className={styles.spinner}>Searching…</div>}
        <div className={styles.results}>
          {tracks.map((t) => (
            <div key={t.id} className={styles.resRow}>
              <div className={styles.resArt} style={{ backgroundImage: t.art ? `url(${t.art})` : undefined }} />
              <div className={styles.resMeta}>
                <div className={styles.resTitle}>{t.name}</div>
                <div className={styles.resSub}>{t.artists}</div>
              </div>
              <div className={styles.resActions}>
                <button type="button" className={styles.miniBtn} onClick={() => queueTrack(t)}>Queue</button>
                <button type="button" className={styles.miniBtn} onClick={() => playTrack(t)}>Play</button>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* ── focus playlist modal ── */}
      <Modal
        open={focusOpen}
        onClose={() => setFocusOpen(false)}
        title="Build a Focus Playlist"
      >
        <p className={styles.focusHint}>
          Describe a mood or task — Axis distills it, finds seeds across your taste, and assembles a set.
        </p>
        <input
          autoFocus
          className={styles.searchInput}
          placeholder="e.g. deep work, late-night ambient, long run tempo…"
          value={focusPrompt}
          onChange={(e) => setFocusPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !building && buildFocus(true)}
        />
        {building && <div className={styles.spinner}>Building…</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
          <button type="button" className={styles.miniBtn} disabled={building} onClick={() => buildFocus(false)}>
            Queue only
          </button>
          <button type="button" className={styles.setupBtn} disabled={building} onClick={() => buildFocus(true)}>
            Create playlist
          </button>
        </div>
      </Modal>
    </div>
  );
}
