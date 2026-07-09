"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpotify } from "@/components/spotify/SpotifyProvider";
import { useToast } from "@/components/ui/Toast";
import { Modal } from "@/components/ui/Modal";
import { callAiAction } from "@/lib/ai/callAction";
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

/**
 * youtube.com/watch?v=ID, youtu.be/ID, or youtube.com/embed/ID → the official
 * youtube-nocookie.com embed URL. Mirrors toEmbedUrl()'s Spotify pattern: render
 * the dedicated, iframe-friendly embed player directly instead of relaying the
 * full /watch SPA through the page-scraping /api/proxy (which breaks — YouTube's
 * watch page depends on its real origin for cookies, CSP-via-meta, and XHR calls
 * keyed to document.location.origin, none of which survive a proxied relay).
 */
function toYouTubeEmbedUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, "");
    let id: string | null = null;
    if (host === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else if (url.pathname.startsWith("/embed/")) id = url.pathname.split("/")[2] ?? null;
      else if (url.pathname.startsWith("/shorts/")) id = url.pathname.split("/")[2] ?? null;
    }
    if (!id) return null;
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
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
  { text: "DEEP WORK · STEEL", color: "#5b6470", uri: "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DWZeKCadgRdKQ" },
  { text: "LAGOS NIGHTS", color: "#8a5a3a", uri: "spotify:playlist:37i9dQZF1DX4o1oenSJwhd", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX4o1oenSJwhd" },
  { text: "BLUE NOTE ⋅ LATE", color: "#3d5166", uri: "spotify:playlist:37i9dQZF1DXbITWG1ZJKYt", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DXbITWG1ZJKYt" },
  { text: "TEMPO · LONG RUN", color: "#3f5c50", uri: "spotify:playlist:37i9dQZF1DWUVpAXiEPK8P", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DWUVpAXiEPK8P" },
  { text: "AFROBEATS ⋅ NOW", color: "#7a5430", uri: "spotify:playlist:37i9dQZF1DX3LDIBRoaCDQ", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX3LDIBRoaCDQ" },
  { text: "SOUL ⋅ SUNDAY", color: "#6a4858", uri: "spotify:playlist:37i9dQZF1DWTkxQvqMy4WW", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DWTkxQvqMy4WW" },
  { text: "GRIME ⋅ MOTION", color: "#3a3e4a", uri: "spotify:playlist:37i9dQZF1DX6yFH9F1wkNF", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX6yFH9F1wkNF" },
  { text: "JAZZ ⋅ MIDNIGHT", color: "#2a3848", uri: "spotify:playlist:37i9dQZF1DXbITWG1ZJKYt", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DXbITWG1ZJKYt" },
  { text: "R&B ⋅ VAULT", color: "#5a3848", uri: "spotify:playlist:37i9dQZF1DX4SBhb3fqCJd", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX4SBhb3fqCJd" },
  { text: "HIGHLIFE ⋅ GOLD", color: "#7a6030", uri: "spotify:playlist:37i9dQZF1DX3oM43U6PwdB", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX3oM43U6PwdB" },
  { text: "DRILL ⋅ GRIME", color: "#2e3240", uri: "spotify:playlist:37i9dQZF1DX6yFH9F1wkNF", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX6yFH9F1wkNF" },
  { text: "ELECTRONIC ⋅ AM", color: "#3a4858", uri: "spotify:playlist:37i9dQZF1DX6J5NfMJS675", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX6J5NfMJS675" },
];
const SAMPLE_CRATES = [
  { title: "Deep Work · Steel", meta: "42 trk · 2h51", art: "linear-gradient(135deg,#4a5058,#2a2e35)", uri: "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DWZeKCadgRdKQ" },
  { title: "Lagos Nights", meta: "30 trk · 1h58", art: "linear-gradient(135deg,#3a3f48,#22262c)", uri: "spotify:playlist:37i9dQZF1DX4o1oenSJwhd", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DX4o1oenSJwhd" },
  { title: "Blue Note ⋅ Late", meta: "26 trk · 2h12", art: "linear-gradient(135deg,#454a52,#282c32)", uri: "spotify:playlist:37i9dQZF1DXbITWG1ZJKYt", spotifyUrl: "https://open.spotify.com/embed/playlist/37i9dQZF1DXbITWG1ZJKYt" },
];

const SPINE_COLORS = ["#5b6470", "#8a5a3a", "#3d5166", "#3f5c50", "#6a5470", "#7a6440", "#456056", "#52607a"];

// ── Video Lounge data ─────────────────────────────────────────────────────────
type VaultVideo = { id: string; t: string; c: string; d: string; cat: string; g: string; url: string };

const VAULT_VIDEOS: VaultVideo[] = [
  { id: "v1", t: "Burna Boy — Live at Madison Square Garden (Full Concert)", c: "Burna Boy Official", d: "1:22:14", cat: "Music Videos", g: "linear-gradient(135deg,#1c1a2e,#0d0c18)", url: "https://www.youtube.com/watch?v=3VlGRgYBX9Q" },
  { id: "v2", t: "Tems — Free Mind (Official Video)", c: "Tems", d: "4:12", cat: "Music Videos", g: "linear-gradient(135deg,#1a2630,#0c1218)", url: "https://www.youtube.com/watch?v=WLMzD6Br0bI" },
  { id: "v3", t: "Skepta — Shutdown (Official Video)", c: "Skepta", d: "3:45", cat: "Music Videos", g: "linear-gradient(135deg,#1e1e1e,#0a0a0a)", url: "https://www.youtube.com/watch?v=r91MDN3tBFQ" },
  { id: "v4", t: "How Afrobeats Conquered the World", c: "Vox", d: "12:38", cat: "Interviews", g: "linear-gradient(135deg,#2a1c10,#120c06)", url: "https://www.youtube.com/watch?v=cA7y4XRBb3E" },
  { id: "v5", t: "Rick Rubin on Listening, Creativity, and The Creative Act", c: "Tim Ferriss Show", d: "2:18:44", cat: "Interviews", g: "linear-gradient(135deg,#1e1e2e,#0c0c18)", url: "https://www.youtube.com/watch?v=H_szemxPcTI" },
  { id: "v6", t: "Why Does Music Make Us Feel?", c: "Kurzgesagt", d: "11:02", cat: "Theory", g: "linear-gradient(135deg,#1a2040,#0a0c20)", url: "https://www.youtube.com/watch?v=5zVS-UEWWqg" },
  { id: "v7", t: "The Circle of Fifths Explained", c: "Adam Neely", d: "18:22", cat: "Theory", g: "linear-gradient(135deg,#0e2420,#060e0c)", url: "https://www.youtube.com/watch?v=d1aD8uDMHpM" },
  { id: "v8", t: "Kendrick Lamar — GNX Album Breakdown", c: "The Needle Drop", d: "24:15", cat: "Release Breakdowns", g: "linear-gradient(135deg,#1a1018,#0a080c)", url: "https://www.youtube.com/watch?v=b3QH89CpJnw" },
  { id: "v9", t: "Rema — Calm Down (Behind the Scenes)", c: "Mavin Records", d: "8:42", cat: "Release Breakdowns", g: "linear-gradient(135deg,#1e1430,#0c0816)", url: "https://www.youtube.com/watch?v=WcIcVapfqXw" },
  { id: "v10", t: "Miles Davis: The Birth of Cool — Documentary", c: "PBS", d: "53:14", cat: "Artist Docs", g: "linear-gradient(135deg,#1a1a1a,#080808)", url: "https://www.youtube.com/watch?v=ylXk1LBvIqU" },
  { id: "v11", t: "Fela Kuti: Music Is The Weapon", c: "MUBI", d: "51:22", cat: "Artist Docs", g: "linear-gradient(135deg,#1e1408,#0c0a04)", url: "https://www.youtube.com/watch?v=YaSdB4v2GWc" },
  { id: "v12", t: "What Makes a Song Great? (Analyzing Hits)", c: "Rick Beato", d: "22:08", cat: "Theory", g: "linear-gradient(135deg,#10182a,#080c14)", url: "https://www.youtube.com/watch?v=PHgPVrQn_58" },
];

const VIDEO_CATS = ["All", "Music Videos", "Interviews", "Theory", "Release Breakdowns", "Artist Docs"];

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

function RecordPlayer({ playing }: { playing: boolean }) {
  return (
    <svg
      viewBox="0 0 148 148"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 148, height: 148, filter: "drop-shadow(0 14px 32px rgba(0,0,0,.7))" }}
      aria-hidden
    >
      <defs>
        <radialGradient id="rp-plt" cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#c1c4c7" />
          <stop offset="28%" stopColor="#8898b8" />
          <stop offset="62%" stopColor="#404c68" />
          <stop offset="100%" stopColor="#24283c" />
        </radialGradient>
        <radialGradient id="rp-vin" cx="32%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#1e2028" />
          <stop offset="55%" stopColor="#0c0c12" />
          <stop offset="100%" stopColor="#070710" />
        </radialGradient>
        <radialGradient id="rp-lbl" cx="38%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#d44040" />
          <stop offset="52%" stopColor="#8a1c1c" />
          <stop offset="100%" stopColor="#3c0808" />
        </radialGradient>
        <linearGradient id="rp-arm" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c1c4c7" />
          <stop offset="42%" stopColor="#d8dce8" />
          <stop offset="100%" stopColor="#606878" />
        </linearGradient>
      </defs>

      {/* Platter base */}
      <circle cx="74" cy="74" r="68" fill="url(#rp-plt)" />
      <circle cx="74" cy="74" r="68" fill="none" stroke="rgba(193,196,199,.28)" strokeWidth="1.2" />
      <circle cx="74" cy="74" r="63" fill="none" stroke="rgba(193,196,199,.1)" strokeWidth="1" />
      <circle cx="74" cy="74" r="59.5" fill="none" stroke="rgba(100,115,155,.15)" strokeWidth="0.6" />

      {/* Vinyl record — spins */}
      <g style={{ transformOrigin: "center", transformBox: "fill-box", animationName: "vspin", animationDuration: playing ? "2s" : "4s", animationTimingFunction: "linear", animationIterationCount: "infinite", animationPlayState: "running" } as React.CSSProperties}>
        <circle cx="74" cy="74" r="57" fill="url(#rp-vin)" />
        {[53,49,45,41,37,33,29,25].map((r) => (
          <circle key={r} cx="74" cy="74" r={r} fill="none" stroke="rgba(45,50,65,.85)" strokeWidth="0.85" />
        ))}
        {/* Asymmetric sheen arc — makes rotation visually obvious */}
        <path d="M 44 55 A 36 36 0 0 1 74 40" fill="none" stroke="rgba(193,196,199,.14)" strokeWidth="11" strokeLinecap="round" />
        {/* Label */}
        <circle cx="74" cy="74" r="18" fill="url(#rp-lbl)" />
        <line x1="63" y1="71" x2="85" y2="71" stroke="rgba(255,220,220,.18)" strokeWidth="0.8" />
        <line x1="63" y1="74" x2="85" y2="74" stroke="rgba(255,220,220,.12)" strokeWidth="0.6" />
        <line x1="63" y1="77" x2="85" y2="77" stroke="rgba(255,220,220,.08)" strokeWidth="0.5" />
        {/* Spindle */}
        <circle cx="74" cy="74" r="3.5" fill="#c1c4c7" />
        <circle cx="74" cy="74" r="1.8" fill="#08080e" />
      </g>

      {/* Tonearm */}
      <circle cx="120" cy="24" r="6.5" fill="url(#rp-plt)" stroke="rgba(193,196,199,.35)" strokeWidth="1" />
      <circle cx="120" cy="24" r="3.2" fill="rgba(193,196,199,.85)" />
      <line x1="120" y1="24" x2="84" y2="64" stroke="url(#rp-arm)" strokeWidth="4" strokeLinecap="round" />
      <line x1="84" y1="64" x2="74" y2="78" stroke="url(#rp-arm)" strokeWidth="3" strokeLinecap="round" />
      <rect x="70" y="75" width="9" height="5" rx="1.5" fill="#c1c4c7" opacity=".85" transform="rotate(-42 74 77)" />
      <line x1="72" y1="80" x2="70" y2="85" stroke="rgba(193,196,199,.5)" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ── Audio Visualizer ─────────────────────────────────────────────────────────

function AudioVisualizer({ playing }: { playing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const barsRef = useRef<number[]>(Array.from({ length: 32 }, () => 0.08));
  const velsRef = useRef<number[]>(Array.from({ length: 32 }, () => 0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const N = barsRef.current.length;
    const barW = (W / N) * 0.68;
    const gap = (W / N) * 0.32;

    function tick() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);

      for (let i = 0; i < N; i++) {
        if (playing) {
          // Simulate frequency spectrum: center frequencies higher
          const center = 0.5 - Math.abs(i / N - 0.5);
          const target = 0.12 + center * 0.7 * (0.5 + 0.5 * Math.sin(Date.now() / 180 + i * 0.8 + Math.sin(Date.now() / 420 + i)));
          velsRef.current[i] = velsRef.current[i] * 0.72 + (target - barsRef.current[i]) * 0.28;
          barsRef.current[i] = Math.max(0.03, Math.min(0.96, barsRef.current[i] + velsRef.current[i]));
        } else {
          barsRef.current[i] += (0.04 - barsRef.current[i]) * 0.08;
        }

        const h = barsRef.current[i] * H;
        const x = i * (barW + gap);
        const y = (H - h) / 2;

        // Silver gradient bar
        const grad = ctx.createLinearGradient(0, y, 0, y + h);
        grad.addColorStop(0, playing ? "rgba(193,196,199,.18)" : "rgba(193,196,199,.08)");
        grad.addColorStop(0.4, playing ? "rgba(210,215,220,.55)" : "rgba(193,196,199,.18)");
        grad.addColorStop(0.5, playing ? "rgba(225,228,232,.72)" : "rgba(193,196,199,.22)");
        grad.addColorStop(0.6, playing ? "rgba(210,215,220,.55)" : "rgba(193,196,199,.18)");
        grad.addColorStop(1, playing ? "rgba(193,196,199,.18)" : "rgba(193,196,199,.08)");
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, h);
      }

      frameRef.current = requestAnimationFrame(tick);
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [playing]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={44}
      style={{ display: "block", width: "100%", height: 44, opacity: playing ? 1 : 0.45, transition: "opacity .6s" }}
      aria-hidden
    />
  );
}

// ── Taste Map ─────────────────────────────────────────────────────────────────

type TasteGenre = { label: string; pct: number; color: string };

const FALLBACK_GENRES: TasteGenre[] = [
  { label: "Afrobeats", pct: 82, color: "#c9a463" },
  { label: "R&B / Soul", pct: 71, color: "#c2603f" },
  { label: "Hip-Hop", pct: 64, color: "#3f6fb0" },
  { label: "Jazz", pct: 48, color: "#7fa86a" },
  { label: "Electronic", pct: 38, color: "#9aa7b8" },
  { label: "Drill / Grime", pct: 32, color: "#8a5a7a" },
  { label: "Highlife", pct: 29, color: "#b8863f" },
  { label: "Indie / Alt", pct: 18, color: "#5b8fd0" },
];

function TasteMap({ artists, tasteIteration, onIterate }: { artists: ArtistLite[]; tasteIteration: number; onIterate: () => void }) {
  const genres: TasteGenre[] = useMemo(() => {
    if (!artists.length) return FALLBACK_GENRES;
    const freq: Record<string, number> = {};
    for (const a of artists) {
      for (const g of (a.genres ?? [])) {
        const key = g.charAt(0).toUpperCase() + g.slice(1);
        freq[key] = (freq[key] ?? 0) + 1;
      }
    }
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = sorted[0]?.[1] ?? 1;
    const palette = ["#c9a463", "#c2603f", "#3f6fb0", "#7fa86a", "#9aa7b8", "#8a5a7a", "#b8863f", "#5b8fd0"];
    return sorted.map(([label, count], i) => ({ label, pct: Math.round((count / max) * 100), color: palette[i % palette.length] }));
  }, [artists]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h2 className="sec" style={{ margin: 0 }}>Taste Map<span className="rule" /><span className="count">{artists.length > 0 ? "Spotify · live" : "Sample"}</span></h2>
          <p style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4, fontFamily: "var(--mono)" }}>Derived from your top artist genres · {tasteIteration > 0 ? `refreshed ${tasteIteration}×` : "live"}</p>
        </div>
        <button type="button" className="feed-manage" onClick={onIterate}>↻ Iterate</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16, alignItems: "start" }}>
        {/* radar-style SVG */}
        <svg viewBox="0 0 220 220" style={{ width: "100%", maxWidth: 220, margin: "0 auto" }}>
          {[80, 60, 40, 20].map((r) => (
            <circle key={r} cx="110" cy="110" r={r} fill="none" stroke="var(--line)" strokeWidth="0.8" />
          ))}
          {genres.map((_, i, arr) => {
            const angle = (i / arr.length) * 2 * Math.PI - Math.PI / 2;
            return <line key={i} x1="110" y1="110" x2={110 + 80 * Math.cos(angle)} y2={110 + 80 * Math.sin(angle)} stroke="var(--line)" strokeWidth="0.6" />;
          })}
          <polygon
            points={genres.map((g, i) => {
              const angle = (i / genres.length) * 2 * Math.PI - Math.PI / 2;
              const r2 = (g.pct / 100) * 80;
              return `${110 + r2 * Math.cos(angle)},${110 + r2 * Math.sin(angle)}`;
            }).join(" ")}
            fill="rgba(201,164,99,.12)"
            stroke="var(--gold)"
            strokeWidth="1.4"
          />
          {genres.map((g, i) => {
            const angle = (i / genres.length) * 2 * Math.PI - Math.PI / 2;
            const r2 = (g.pct / 100) * 80;
            return <circle key={i} cx={110 + r2 * Math.cos(angle)} cy={110 + r2 * Math.sin(angle)} r="3.5" fill={g.color} />;
          })}
          {genres.map((g, i) => {
            const angle = (i / genres.length) * 2 * Math.PI - Math.PI / 2;
            const lx = 110 + 92 * Math.cos(angle);
            const ly = 110 + 92 * Math.sin(angle);
            return (
              <text key={i} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" style={{ fill: "var(--ink-faint)", fontSize: 7, fontFamily: "var(--mono)" }}>
                {g.label.split(" ")[0]}
              </text>
            );
          })}
        </svg>

        {/* genre bars */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {genres.map((g) => (
            <div key={g.label}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 11, color: "var(--ink)", fontFamily: "var(--sans)" }}>{g.label}</span>
                <span style={{ fontSize: 9.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>{g.pct}%</span>
              </div>
              <div style={{ height: 4, background: "var(--line)", borderRadius: 2 }}>
                <div style={{ height: "100%", borderRadius: 2, background: g.color, width: `${g.pct}%`, transition: "width .6s ease" }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* mood board tiles */}
      <h2 className="sec" style={{ marginTop: 24, marginBottom: 14 }}>Mood Board<span className="rule" /></h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 8 }}>
        {[
          { label: "Late Night", sub: "deep, introspective", g: "linear-gradient(135deg,#1a1a2e,#0a0a18)" },
          { label: "Lagos Heat", sub: "afro, uptempo", g: "linear-gradient(135deg,#2e1808,#180e04)" },
          { label: "Blue Note", sub: "jazz, soul", g: "linear-gradient(135deg,#0e1e2e,#060e18)" },
          { label: "Energy", sub: "drill, grime", g: "linear-gradient(135deg,#1e1e1e,#0a0a0a)" },
        ].map((m) => (
          <div key={m.label} style={{ background: m.g, borderRadius: "var(--r)", padding: "14px 12px", border: "1px solid var(--line)" }}>
            <div style={{ fontFamily: "var(--narrow)", fontSize: 11.5, fontWeight: 700, color: "var(--gold)", letterSpacing: ".04em", marginBottom: 3 }}>{m.label}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--ink-faint)" }}>{m.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Recommendations ───────────────────────────────────────────────────────────

type Rec = { id: string; artist: string; track: string; reason: string; genre: string; g: string };

const SAMPLE_RECS: Rec[] = [
  { id: "rc1", artist: "Asake", track: "Lonely at the Top", reason: "Matches your Afrobeats peak listening window", genre: "Afrobeats", g: "linear-gradient(135deg,#2e1808,#180e04)" },
  { id: "rc2", artist: "Little Simz", track: "Woman (feat. Cleo Sol)", reason: "Bridges your R&B and UK rap taste nodes", genre: "R&B / Hip-Hop", g: "linear-gradient(135deg,#1e1e1e,#0a0a0a)" },
  { id: "rc3", artist: "Floating Points", track: "Reflections — Mojave Desert", reason: "Evening-mode electronic aligns with your jazz nodes", genre: "Electronic / Jazz", g: "linear-gradient(135deg,#0e1e2e,#060e18)" },
  { id: "rc4", artist: "Fireboy DML", track: "Peru", reason: "High rotation in your Afropop cluster", genre: "Afropop", g: "linear-gradient(135deg,#1a1430,#0a0818)" },
  { id: "rc5", artist: "Sampha", track: "Spirit 2.0", reason: "Intersects your soul and electronic taste graph", genre: "Soul / Electronic", g: "linear-gradient(135deg,#1e1028,#0e0814)" },
  { id: "rc6", artist: "Polo G", track: "Pop Out", reason: "Drill energy matching your late-night peak", genre: "Drill", g: "linear-gradient(135deg,#181818,#080808)" },
];

type ToastFn = ReturnType<typeof useToast>["toast"];

function PlayRecButton({ rec, spotify, toast }: { rec: Rec; spotify: ReturnType<typeof useSpotify>; toast: ToastFn }) {
  const [loading, setLoading] = useState(false);

  const play = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/spotify/search?q=${encodeURIComponent(`${rec.track} ${rec.artist}`)}&type=track`,
        { cache: "no-store" },
      );
      const data = await res.json();
      const uri: string | undefined = data.tracks?.[0]?.uri;
      if (uri) {
        await spotify.playUris([uri]);
        toast(`Playing ${rec.track}`, "success", "Vault");
      } else {
        toast("Track not found on Spotify", "warn", "Vault");
      }
    } catch {
      toast("Couldn't reach Spotify", "error", "Vault");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      disabled={loading}
      style={{ marginTop: 4, fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".07em", padding: "5px 10px", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "transparent", color: loading ? "var(--ink-faint)" : "var(--gold)", cursor: loading ? "default" : "pointer", alignSelf: "flex-start", transition: ".14s" }}
      onClick={play}
    >
      {loading ? "Finding…" : "▶ Play on Spotify"}
    </button>
  );
}

function RecommendationsSection({ connected, spotify, toast }: { connected: boolean; spotify: ReturnType<typeof useSpotify>; toast: ToastFn }) {
  const [recs, setRecs] = useState<Rec[]>(SAMPLE_RECS);
  const [loading, setLoading] = useState(false);
  const [aiInsight, setAiInsight] = useState("");

  const refreshRecs = async () => {
    setLoading(true);
    // Previously misused mode:"capture" (which returns {label,action,priority},
    // not a rec array) so Refresh silently no-op'd. Now uses the dedicated
    // typed music-recs action.
    try {
      const result = await callAiAction("musicRecs", {
        text: "Give me 3 diverse music recommendations based on a taste for Afrobeats, R&B, and late-night jazz. Vary tempos and moods.",
      });
      if (result.ok && result.data.recs.length) {
        const colors = ["linear-gradient(135deg,#2e1808,#180e04)", "linear-gradient(135deg,#0e1e2e,#060e18)", "linear-gradient(135deg,#1e1e1e,#0a0a0a)"];
        setRecs(result.data.recs.map((r, i) => ({ ...r, id: `ai${i}`, g: colors[i % colors.length] })));
        setAiInsight("Refreshed from your taste profile — Afrobeats, R&B, and late-night jazz nodes are dominant.");
      } else if (!result.ok) {
        toast("Couldn't refresh recommendations — check the AI key in Control Room.", "error", "Vault");
      }
    } finally { setLoading(false); }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h2 className="sec" style={{ margin: 0 }}>Recommendations<span className="rule" /><span className="count">{connected ? "Spotify-informed" : "Sample taste"}</span></h2>
          {aiInsight && <p style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 4, fontFamily: "var(--mono)" }}>{aiInsight}</p>}
        </div>
        <button type="button" className="feed-manage" onClick={refreshRecs} disabled={loading}>{loading ? "…" : "✦ Refresh"}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
        {recs.map((r) => (
          <div key={r.id} style={{ background: r.g, borderRadius: "var(--rl)", border: "1px solid var(--line)", padding: "14px 14px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontFamily: "var(--narrow)", fontSize: 9.5, color: "var(--gold)", textTransform: "uppercase", letterSpacing: ".08em" }}>{r.genre}</div>
            <div style={{ fontFamily: "var(--serif)", fontSize: 14, color: "var(--ink)", lineHeight: 1.3 }}>{r.track}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--ink-dim)" }}>{r.artist}</div>
            <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--ink-faint)", lineHeight: 1.5 }}>{r.reason}</div>
            {connected && (
              <PlayRecButton rec={r} spotify={spotify} toast={toast} />
            )}
          </div>
        ))}
      </div>

      {!connected && (
        <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--glass)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 11, color: "var(--ink-faint)" }}>
          Connect Spotify above to power recommendations from your actual listening history.
        </div>
      )}
    </div>
  );
}

// ── Video Lounge ──────────────────────────────────────────────────────────────

function VideoLounge() {
  const [cat, setCat] = useState("All");
  const [playing, setPlaying] = useState<VaultVideo | null>(null);
  const visible = cat === "All" ? VAULT_VIDEOS : VAULT_VIDEOS.filter((v) => v.cat === cat);

  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlaying(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [playing]);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ marginBottom: 18 }}>
        <h2 className="sec" style={{ margin: "0 0 6px" }}>Video Lounge<span className="rule" /><span className="count">Culture Feed</span></h2>
        <p style={{ fontSize: 10.5, color: "var(--ink-faint)", fontFamily: "var(--mono)" }}>Music videos, theory, interviews, release breakdowns.</p>
      </div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {VIDEO_CATS.map((c) => (
          <button key={c} type="button" className={`chip${cat === c ? " on" : ""}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      <div className="vidgrid">
        {visible.map((v) => (
          <div key={v.id} className="vid" onClick={() => setPlaying(v)} style={{ cursor: "pointer" }}>
            <div className="vthumb" style={{ background: v.g }}>
              <span className="tag">{v.cat}</span>
              <div className="pl"><span /></div>
              <span className="dur">{v.d}</span>
            </div>
            <div className="vb">
              <div className="vt">{v.t}</div>
              <div className="vc">
                <span>{v.c}</span>
                <span>YouTube</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── YouTube player overlay — direct official embed (mirrors Spotify's
          embed iframe pattern), not the page-scraping /api/proxy webview ── */}
      {playing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={playing.t}
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.86)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          onClick={() => setPlaying(null)}
        >
          <div style={{ width: "min(960px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--ink)", paddingRight: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{playing.t}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                {/* Escape hatch: many official/label videos disable embedding,
                    which renders as "Video unavailable" inside the iframe — this
                    always opens the real video on YouTube. */}
                <a
                  href={playing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".06em", color: "var(--ink-dim)", textDecoration: "none", whiteSpace: "nowrap" }}
                >
                  Watch on YouTube ↗
                </a>
                <button
                  type="button"
                  onClick={() => setPlaying(null)}
                  aria-label="Close"
                  style={{ background: "none", border: "none", color: "var(--ink-faint)", cursor: "pointer", fontSize: 20, lineHeight: 1, flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            </div>
            <div style={{ position: "relative", width: "100%", paddingTop: "56.25%", background: "#000", borderRadius: "var(--rl)", overflow: "hidden", border: "1px solid var(--line)" }}>
              {(() => {
                const embed = toYouTubeEmbedUrl(playing.url);
                return embed ? (
                  <iframe
                    src={embed}
                    title={playing.t}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                  />
                ) : (
                  <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--ink-faint)", fontSize: 12 }}>
                    Couldn&apos;t load this video.
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function VaultModule() {
  const spotify = useSpotify();
  const { toast } = useToast();
  const { connected, configured, now, liveProgressMs, playing } = spotify;

  const [vaultTab, setVaultTab] = useState<"room" | "taste" | "recs" | "video">("room");
  const [tasteIteration, setTasteIteration] = useState(0);
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
      // Playlists, albums, and artists need context_uri; tracks use uris[].
      const isContext = /^spotify:(playlist|album|artist):/.test(item.uri);
      if (isContext) {
        await spotify.playContext(item.uri);
      } else {
        await spotify.playUris([item.uri]);
      }
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
        spotifyUrl: undefined as string | undefined,
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
      {!connected && (
        <div className="module-status module-status-lab" style={{ marginBottom: 14 }}>
          <div>
            <div className="module-status-kicker">Lab preview</div>
            <strong>Listening Vault is showing curated sample crates.</strong>
            <p>Connect Spotify to load your library, rotation, and personalized recommendations.</p>
          </div>
          <span>Video Lounge items are curated links — not synced from a provider.</span>
        </div>
      )}
      {/* ── Vault tab bar ── */}
      <div className="subtabbar" style={{ marginBottom: 0, paddingBottom: 4 }}>
        {(["room", "taste", "recs", "video"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`subtab${vaultTab === t ? " on" : ""}`}
            onClick={() => setVaultTab(t)}
          >
            {t === "room" ? "Record Room" : t === "taste" ? "Taste Map" : t === "recs" ? "Recommendations" : "Video Lounge"}
          </button>
        ))}
      </div>

      {/* ── Taste Map ── */}
      {vaultTab === "taste" && (
        <div className="vault-panel">
          <TasteMap artists={artists} tasteIteration={tasteIteration} onIterate={() => setTasteIteration((n) => n + 1)} />
        </div>
      )}

      {/* ── Recommendations ── */}
      {vaultTab === "recs" && (
        <div className="vault-panel">
          <RecommendationsSection connected={connected} spotify={spotify} toast={toast} />
        </div>
      )}

      {/* ── Video Lounge ── */}
      {vaultTab === "video" && (
        <div className="vault-panel">
          <VideoLounge />
        </div>
      )}

      <div className="vault-room" style={{ display: vaultTab === "room" ? undefined : "none" }}>
        <div className="vr-frame">
          <div className="vr-silver-strip" aria-hidden />
          <div className="vault-hero">
            <div className="vh-left">
              <div className="vh-eyebrow">Restricted · Listening Vault</div>
              <div className="vh-title">The Record Room</div>
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
              onClick={() => connected && spotify.togglePlay()}
              role={connected ? "button" : undefined}
              title={connected ? (playing ? "Pause" : "Play") : undefined}
              style={{ cursor: connected ? "pointer" : "default", flexShrink: 0 }}
            >
              <RecordPlayer playing={playing} />
            </div>
          </div>


          {/* ── Audio visualizer ── */}
          <div style={{ marginBottom: 20 }}>
            <AudioVisualizer playing={playing} />
          </div>
          {/* ── A — Rotation: active listening rotation ── */}
          <div className="vr-shelf-label">
            A — Rotation <span>· {connected ? "your top artists" : "active rotation · sample"}</span>
          </div>
          <div className="spine-shelf">
            {spines.map((s) => (
              <div
                key={s.text}
                className="spine"
                style={{ "--sc": s.color, cursor: "pointer" } as React.CSSProperties}
                title={s.uri ? `Play ${s.text}` : `Load ${s.text} in player`}
                onClick={() => {
                  if (s.uri) {
                    spotify.playContext(s.uri).then(() => toast(`Playing ${s.text}`, "success", "Vault"));
                  } else if (s.spotifyUrl) {
                    setEmbedUrl(s.spotifyUrl);
                    toast(`Loaded ${s.text}`, "info", "Vault");
                  }
                }}
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
            {connected ? tabLabel[kind] : "B — Crates"} <span>· {connected ? "your collection · tap to play" : "curated picks · tap to load"}</span>
          </div>
          <div className="crate-row">
            {showSample &&
              SAMPLE_CRATES.map((c) => (
                <button
                  key={c.title}
                  type="button"
                  className={`crate ${styles.crateBtn}`}
                  onClick={() => {
                    if (connected) {
                      spotify.playContext(c.uri).then(() => toast(`Playing ${c.title}`, "success", "Vault"));
                    } else {
                      setEmbedUrl(c.spotifyUrl);
                      toast(`Loaded ${c.title}`, "info", "Vault");
                    }
                  }}
                  title={connected ? `Play ${c.title} on Spotify` : `Load ${c.title} in player`}
                >
                  <div className="cr-art" style={{ background: c.art }}>
                    <span className={styles.playOverlay} aria-hidden>
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d={ICON.play} /></svg>
                    </span>
                  </div>
                  <div className="cr-b">
                    <div className="cr-t">{c.title}</div>
                    <div className="cr-m">{c.meta}</div>
                  </div>
                </button>
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
              {embedUrl !== DEFAULT_EMBED && (
                <a
                  href={embedUrl.replace("/embed/", "/").split("?")[0]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="vp-open"
                  title="Open in Spotify"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                  </svg>
                </a>
              )}
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
