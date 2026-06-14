export type AccentPreset = "gold" | "marine" | "clay" | "bone" | "sage" | "chrome";
export type SurfaceTone = "deep" | "mid" | "lifted";
export type DisplayFace = "instrument" | "playfair" | "grotesk";
export type BodyFace = "archivo" | "inter" | "plex";
export type Density = "cozy" | "default" | "compact";
export type Companion = "deck" | "monolith" | "nova";
export type Presence = "show" | "hide";
export type NotifType = "banner" | "silent" | "none";
export type NotifFeatures = {
  pomodoro: boolean;
  agenda: boolean;
  mail: boolean;
  contacts: boolean;
  literature: boolean;
  markets: boolean;
  dispatch: boolean;
};

export type InterfaceSettings = {
  accent: AccentPreset;
  surfaceTone: SurfaceTone;
  cornerRadius: number;
  displayFace: DisplayFace;
  bodyFace: BodyFace;
  density: Density;
  companion: Companion;
  presence: Presence;
  locationServices: boolean;
  notifEnabled: boolean;
  notifType: NotifType;
  notifFeatures: NotifFeatures;
};

export const DEFAULT_INTERFACE_SETTINGS: InterfaceSettings = {
  accent: "gold",
  surfaceTone: "mid",
  cornerRadius: 3,
  displayFace: "instrument",
  bodyFace: "archivo",
  density: "default",
  companion: "monolith",
  presence: "hide",
  locationServices: false,
  notifEnabled: false,
  notifType: "banner",
  notifFeatures: {
    pomodoro: true,
    agenda: true,
    mail: false,
    contacts: false,
    literature: false,
    markets: false,
    dispatch: true,
  },
};

// accent: drives the molten-gold signal channel (--gold family) AND the legacy
// --accent aliases. accent2 is the secondary/data tone (maps to --marine).
export const ACCENT_PRESETS: Record<
  AccentPreset,
  { accent: string; accentBright: string; accentDeep: string; accent2: string; label: string }
> = {
  gold:   { accent: "#c9a463", accentBright: "#e0c388", accentDeep: "#9a7c46", accent2: "#3f6fb0", label: "Atelier Gold" },
  marine: { accent: "#5b8fd0", accentBright: "#8bb4e6", accentDeep: "#3f6fb0", accent2: "#c9a463", label: "Ultramarine" },
  clay:   { accent: "#c2603f", accentBright: "#d98a5f", accentDeep: "#8f4326", accent2: "#c9a463", label: "Terra Clay" },
  bone:   { accent: "#cdc7bb", accentBright: "#e8e4dc", accentDeep: "#8b8579", accent2: "#3f6fb0", label: "Bone" },
  sage:   { accent: "#7fa86a", accentBright: "#9fc484", accentDeep: "#5d8549", accent2: "#c9a463", label: "Sage" },
  chrome: { accent: "#9aa7b8", accentBright: "#c2ccd9", accentDeep: "#6c7686", accent2: "#c9a463", label: "Void Chrome" },
};

// Legacy keys from the previous Motivated-Dew palette — reset to gold if encountered.
const STALE_ACCENTS = new Set(["iris", "arctic", "sapphire", "emerald", "platinum", "neon"]);

const SURFACE_TOKENS = ["--bg", "--surface", "--surface-2", "--surface-3"] as const;
const GLASS_TOKENS = ["--glass", "--glass-2"] as const;

function applySurfaceTone(settings: InterfaceSettings, isLight: boolean) {
  const root = document.documentElement;
  [...SURFACE_TOKENS, ...GLASS_TOKENS, "--line"].forEach((t) => root.style.removeProperty(t));

  if (settings.surfaceTone === "mid") {
    root.dataset.tone = "mid";
    return;
  }

  // deep = recede + darken + more transparent glass; lifted = raise + brighten + denser glass
  const deep = settings.surfaceTone === "deep";
  // In light mode the polarity inverts (deep should darken the warm paper too).
  const surfaceMix = deep ? "black" : isLight ? "black" : "white";
  const surfacePct = deep ? 14 : isLight ? 4 : 9;

  for (const token of SURFACE_TOKENS) {
    const base = getComputedStyle(root).getPropertyValue(token).trim();
    if (base) root.style.setProperty(token, `color-mix(in srgb, ${base} ${100 - surfacePct}%, ${surfaceMix} ${surfacePct}%)`);
  }

  // Panel glass: deep -> more transparent (panels sink into the void);
  // lifted -> blend in bone/white so panels read as raised slabs.
  for (const token of GLASS_TOKENS) {
    const base = getComputedStyle(root).getPropertyValue(token).trim();
    if (!base) continue;
    if (deep) {
      root.style.setProperty(token, `color-mix(in srgb, ${base} 55%, transparent)`);
    } else {
      root.style.setProperty(token, `color-mix(in srgb, ${base} 100%, ${isLight ? "rgba(60,50,34,1)" : "rgba(232,228,220,1)"} 9%)`);
    }
  }

  // Hairlines firm up slightly when lifted, soften when deep.
  const line = getComputedStyle(root).getPropertyValue("--line").trim();
  if (line) {
    root.style.setProperty("--line", deep ? `color-mix(in srgb, ${line} 75%, transparent)` : `color-mix(in srgb, ${line} 100%, ${isLight ? "black" : "white"} 6%)`);
  }

  root.dataset.tone = settings.surfaceTone;
}

export function applyInterfaceSettings(settings: InterfaceSettings) {
  const root = document.documentElement;
  const body = document.body;
  const isLight = root.classList.contains("light");

  // ── Accent: drive the gold signal channel + legacy aliases on <html> ──
  const accentKey: AccentPreset = STALE_ACCENTS.has(settings.accent as string)
    ? "gold"
    : settings.accent in ACCENT_PRESETS
      ? settings.accent
      : "gold";
  const preset = ACCENT_PRESETS[accentKey];

  // primary signal channel — the 77 var(--gold*) call sites read these
  root.style.setProperty("--gold", preset.accent);
  root.style.setProperty("--gold-2", preset.accentBright);
  root.style.setProperty("--gold-deep", preset.accentDeep);
  // legacy aliases used by the theme system / inline component styles
  root.style.setProperty("--accent", preset.accent);
  root.style.setProperty("--accent-bright", preset.accentBright);
  root.style.setProperty("--accent-2", preset.accent2);
  // secondary data tone
  root.style.setProperty("--marine", preset.accent2);
  // accent-driven glow recipes
  root.style.setProperty("--glow", `0 0 12px color-mix(in srgb, ${preset.accent} 30%, transparent)`);
  root.style.setProperty("--glow-soft", `0 0 22px color-mix(in srgb, ${preset.accent} 14%, transparent)`);

  root.style.setProperty("--r", `${settings.cornerRadius}px`);
  root.style.setProperty("--rl", `${Math.max(settings.cornerRadius + 4, 4)}px`);

  applySurfaceTone(settings, isLight);

  // ── Faces: MUST be set on <body>, where next/font's --font-* vars are in
  // scope. Setting them on <html> is shadowed by the body{} rule in globals.css. ──
  const displayMap: Record<DisplayFace, string> = {
    instrument: 'var(--font-serif), "Fraunces", Georgia, serif',
    playfair: 'var(--font-playfair), "Playfair Display", Georgia, serif',
    grotesk: 'var(--font-grotesk), "Space Grotesk", var(--font-narrow), sans-serif',
  };
  const bodyMap: Record<BodyFace, string> = {
    archivo: 'var(--font-sans), "Archivo", -apple-system, sans-serif',
    inter: 'var(--font-inter), "Inter", -apple-system, sans-serif',
    plex: 'var(--font-plex), "IBM Plex Sans", -apple-system, sans-serif',
  };
  body.style.setProperty("--serif", displayMap[settings.displayFace] ?? displayMap.instrument);
  body.style.setProperty("--sans", bodyMap[settings.bodyFace] ?? bodyMap.archivo);

  body.dataset.density = settings.density;
  root.dataset.companion = settings.companion;
  root.dataset.presence = settings.presence;
}
