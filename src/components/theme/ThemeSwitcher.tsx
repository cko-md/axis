"use client";

import { useTheme } from "./ThemeProvider";
import type { ThemeMode } from "@/lib/types";

const MODES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "dim", label: "Dim" },
  { id: "light", label: "Light" },
  { id: "slate", label: "Slate" },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="theme-switcher">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => setTheme(m.id)}
          className={theme === m.id ? "on" : ""}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
