"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemeMode } from "@/lib/types";
import {
  applyInterfaceSettings,
  DEFAULT_INTERFACE_SETTINGS,
  type InterfaceSettings,
} from "@/lib/theme/interface-settings";

type ThemeContextValue = {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  interfaceSettings: InterfaceSettings;
  setInterfaceSettings: (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => void;
  openInterfaceStudio: () => void;
  closeInterfaceStudio: () => void;
  interfaceStudioOpen: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_KEY = "axis-theme";
const SETTINGS_KEY = "axis-interface-settings";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  const [interfaceSettings, setInterfaceSettingsState] = useState<InterfaceSettings>(DEFAULT_INTERFACE_SETTINGS);
  const [interfaceStudioOpen, setInterfaceStudioOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) as ThemeMode | null;
    if (stored && ["dark", "dim", "light", "slate"].includes(stored)) setThemeState(stored);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setInterfaceSettingsState({ ...DEFAULT_INTERFACE_SETTINGS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const html = document.documentElement;
    html.classList.remove("dim", "light", "slate");
    if (theme !== "dark") html.classList.add(theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, mounted]);

  useEffect(() => {
    if (!mounted) return;
    // theme stays a dependency: surface-tone color-mix must re-derive from the new theme's base tokens
    applyInterfaceSettings(interfaceSettings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(interfaceSettings));
  }, [interfaceSettings, theme, mounted]);

  const setTheme = (t: ThemeMode) => setThemeState(t);
  const setInterfaceSettings = useCallback(
    (s: InterfaceSettings | ((prev: InterfaceSettings) => InterfaceSettings)) => {
      setInterfaceSettingsState(s);
    },
    [],
  );
  const openInterfaceStudio = () => setInterfaceStudioOpen(true);
  const closeInterfaceStudio = () => setInterfaceStudioOpen(false);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        interfaceSettings,
        setInterfaceSettings,
        openInterfaceStudio,
        closeInterfaceStudio,
        interfaceStudioOpen,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
