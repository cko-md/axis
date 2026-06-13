"use client";

import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";

/**
 * The companion — an austere, sculptural presence rather than a cartoon mascot.
 * Two forms, switchable in Interface Studio:
 *   · monolith — a faceted obelisk (abstract-afrofuturist standing stone)
 *   · deck     — a refined console instrument with a gold oscilloscope line
 * Both stay in the cold-chrome register; the only warmth is a single gold core.
 */

const LINES = [
  "Three deep-work blocks today. The manuscript edit window opens in 1h 48m.",
  "Two signals routed to Agenda. Nothing overdue.",
  "Markets quiet. Your next training block is mobility — 40 minutes.",
  "Reading queue refreshed. One preprint matches your synaptic-plasticity thread.",
];

function Monolith() {
  return (
    <svg viewBox="0 0 84 100" aria-hidden>
      <defs>
        <linearGradient id="monoBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(40,44,52,.92)" />
          <stop offset="100%" stopColor="rgba(14,16,20,.96)" />
        </linearGradient>
        <radialGradient id="monoCore" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--gold-2)" />
          <stop offset="55%" stopColor="var(--gold)" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse className="m-shadow" cx="42" cy="95" rx="17" ry="3.2" fill="rgba(0,0,0,.34)" />
      <g className="m-body">
        {/* faceted obelisk */}
        <path
          d="M42 8 L57 22 L55 90 L29 90 L27 22 Z"
          fill="url(#monoBody)"
          stroke="var(--line-strong)"
          strokeWidth="1"
        />
        {/* gold apex facet — the afrofuturist crown */}
        <path d="M42 8 L57 22 L42 27 L27 22 Z" fill="none" stroke="var(--gold)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M42 8 L42 27" stroke="var(--gold)" strokeWidth=".8" opacity=".55" />
        {/* vertical seam of light */}
        <line x1="42" y1="30" x2="42" y2="86" stroke="var(--gold)" strokeWidth="1" opacity=".22" />
        {/* the single warm aperture / eye */}
        <circle className="mono-core" cx="42" cy="50" r="7" fill="url(#monoCore)" />
        <circle cx="42" cy="50" r="2.4" fill="var(--gold-2)" />
        {/* quiet status ticks */}
        <line x1="34" y1="68" x2="50" y2="68" stroke="var(--ink-faint)" strokeWidth="1" opacity=".6" />
        <line x1="34" y1="74" x2="46" y2="74" stroke="var(--ink-faint)" strokeWidth="1" opacity=".4" />
      </g>
    </svg>
  );
}

function Deck() {
  return (
    <svg viewBox="0 0 84 100" aria-hidden>
      <defs>
        <linearGradient id="deckBody2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(40,44,52,.92)" />
          <stop offset="100%" stopColor="rgba(16,18,23,.96)" />
        </linearGradient>
      </defs>
      <ellipse className="m-shadow" cx="42" cy="92" rx="20" ry="3.4" fill="rgba(0,0,0,.32)" />
      <g className="m-body">
        {/* console slab */}
        <rect x="10" y="34" width="64" height="50" rx="7" fill="url(#deckBody2)" stroke="var(--line-strong)" strokeWidth="1" />
        <rect x="10" y="34" width="64" height="50" rx="7" fill="none" stroke="var(--metal-edge)" strokeWidth="1" opacity=".6" />
        {/* top bevel + power dot */}
        <line x1="18" y1="34" x2="66" y2="34" stroke="var(--edge)" strokeWidth="1" opacity=".5" />
        <circle cx="64" cy="42" r="2" fill="var(--gold)" />
        <circle cx="64" cy="42" r="3.4" fill="none" stroke="var(--gold)" strokeWidth=".8" opacity=".4" />
        {/* oscilloscope window */}
        <rect x="18" y="46" width="48" height="22" rx="3" fill="rgba(8,10,14,.7)" stroke="var(--line)" strokeWidth="1" />
        <polyline
          className="deck-scope"
          points="20,57 26,57 30,50 34,64 38,52 42,60 46,55 52,57 64,57"
          fill="none"
          stroke="var(--gold)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* equalizer trio */}
        <g className="deck-eq" transform="translate(34,73)">
          <rect className="eqb e1" x="0" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
          <rect className="eqb e2" x="5" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
          <rect className="eqb e3" x="10" y="0" width="3" height="7" rx="1" fill="var(--gold)" />
        </g>
      </g>
    </svg>
  );
}

export function Mascot() {
  const { interfaceSettings, setInterfaceSettings } = useTheme();
  const [hidden, setHidden] = useState(false);
  const [bubble, setBubble] = useState(false);
  const line = useMemo(() => LINES[Math.floor((Date.now() / 60000) % LINES.length)], []);

  // close the bubble on Escape
  useEffect(() => {
    if (!bubble) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setBubble(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bubble]);

  if (interfaceSettings.presence === "hide" || hidden) {
    return (
      <button
        type="button"
        className="mascot-restore on"
        title="Show companion"
        onClick={() => {
          setHidden(false);
          setInterfaceSettings((s) => ({ ...s, presence: "show" }));
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 3 L19 9 L17 21 L7 21 L5 9 Z" />
          <circle cx="12" cy="13" r="2.4" />
        </svg>
      </button>
    );
  }

  const isMonolith = interfaceSettings.companion !== "deck";

  return (
    <div
      className={`mascot ${isMonolith ? "char-monolith" : "char-deck"}`}
      title="Tap for a briefing"
      onClick={() => setBubble((b) => !b)}
    >
      <button
        type="button"
        className="m-hide"
        title="Hide companion"
        onClick={(e) => {
          e.stopPropagation();
          setHidden(true);
        }}
      >
        ✕
      </button>
      {isMonolith ? <Monolith /> : <Deck />}
      <div className={`m-bubble${bubble ? " on" : ""}`}>
        <div className="m-bubble-eyebrow">Companion</div>
        {line}
      </div>
    </div>
  );
}
