/**
 * Motivated Dew — Paper palette (AXIS Design Audit)
 *
 * Role mapping:
 * - PRIMARY (2): iris — --accent (#7E8FE8 mid-tone), --accent-bright, --accent-deep
 * - SECONDARY (3): violet → pink — gradient buttons, hero em-text, active states, pills
 * - SECONDARY (5): coral → magenta — gradient stops, highlights
 * - SPARK (1): teal — live/sync indicators only
 * - DEW (4): semantic highlights — success tints, warm captions
 * - SCAFFOLDING (6): slate — background/surface/line tinting across all themes
 *   (the Listening Vault page is standalone and keeps its own self-contained look)
 */
export const motivatedDew = {
  /** Slate-tinted near-black base (swatch 6 scaffolding) */
  obsidian: "#0C101C",

  /** Swatch 2 — PRIMARY */
  iris: {
    accent: "#7E8FE8",
    bright: "#B4C0F4",
    deep: "#23158A",
  },

  /** Swatch 3 — SECONDARY */
  violet: {
    mid: "#A770F6",
    pink: "#E85699",
  },

  /** Swatch 5 — SECONDARY */
  coral: {
    red: "#F44A51",
    magenta: "#BD41B1",
  },

  /** Swatch 1 — spark / live + sync indicators only */
  spark: {
    teal: "#00C9B8",
    bright: "#5EFCE8",
  },

  /** Swatch 4 — semantic highlights */
  dew: {
    mint: "#A1E2A4",
    warm: "#EFC148",
  },

  /** Swatch 6 — background scaffolding tint */
  slate: {
    deep: "#151E3A",
    mid: "#697490",
    /** metallic silver theme surfaces */
    silver: "#C9CFD9",
    steel: "#9AA4B2",
    gunmetal: "#6E7684",
  },

  semantic: {
    up: "#00E8A4",
    down: "#FF5C7A",
    clay: "#C9A882",
  },

  ink: {
    primary: "#EEF0F8",
    dim: "#9AA5C0",
    faint: "#697490",
  },
} as const;
