import type { ThemeMode } from "@/lib/types";
import type { InterfaceSettings } from "@/lib/theme/interface-settings";

type ConsoleThemeQaCase = {
  name: string;
  theme: ThemeMode;
  settings: Partial<InterfaceSettings>;
  viewport: { width: number; height: number };
};

export const CONSOLE_THEME_QA_CASES: ConsoleThemeQaCase[] = [
  {
    name: "dark-default-desktop",
    theme: "dark",
    settings: {},
    viewport: { width: 1440, height: 1100 },
  },
  {
    name: "dim-marine-compact-tablet",
    theme: "dim",
    settings: {
      accent: "marine",
      surfaceTone: "deep",
      density: "compact",
      cornerRadius: 0,
      displayFace: "grotesk",
      bodyFace: "inter",
    },
    viewport: { width: 900, height: 1100 },
  },
  {
    name: "slate-clay-cozy-mobile",
    theme: "slate",
    settings: {
      accent: "clay",
      surfaceTone: "lifted",
      density: "cozy",
      cornerRadius: 16,
      displayFace: "playfair",
      bodyFace: "plex",
    },
    viewport: { width: 390, height: 900 },
  },
  {
    name: "light-chrome-mobile",
    theme: "light",
    settings: {
      accent: "chrome",
      surfaceTone: "mid",
      density: "default",
      cornerRadius: 8,
      locationServices: true,
    },
    viewport: { width: 430, height: 932 },
  },
];

