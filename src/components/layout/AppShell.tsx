"use client";

import { type ReactNode, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Sidebar } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { SpotifyProvider } from "@/components/spotify/SpotifyProvider";

const CommandPalette = dynamic(
  () => import("@/components/nav/CommandPalette").then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);
const Mascot = dynamic(
  () => import("@/components/layout/Mascot").then((m) => ({ default: m.Mascot })),
  { ssr: false },
);
const InterfaceStudioDrawer = dynamic(
  () => import("@/components/theme/InterfaceStudioDrawer").then((m) => ({ default: m.InterfaceStudioDrawer })),
  { ssr: false },
);

type Props = {
  section: string;
  page: string;
  children: ReactNode;
};

type SidebarMode = "open" | "icons" | "hidden";

const NEXT_MODE: Record<SidebarMode, SidebarMode> = {
  open: "icons",
  icons: "hidden",
  hidden: "open",
};

export function AppShell({ section, page, children }: Props) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("open");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isNight, setIsNight] = useState(false);

  useEffect(() => {
    const check = () => {
      const h = new Date().getHours();
      setIsNight(h < 6 || h >= 18);
    };
    check();
    const id = setInterval(check, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Auto-collapse sidebar on narrow viewports
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < 600) setSidebarMode((m) => (m === "open" || m === "icons") ? "hidden" : m);
      else if (w < 860) setSidebarMode((m) => m === "open" ? "icons" : m);
    };
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cycleMode = () => setSidebarMode((m) => NEXT_MODE[m]);

  return (
    <SpotifyProvider>
      <div className="depthfield" aria-hidden>
        <div className="wash" /><div className="aurora" /><div className="aurora2" />
        <div className="haze" /><div className="fall" /><div className="vig" />
        {isNight && <div className="stars" />}
      </div>
      <div className="grain" aria-hidden />
      <div className={`app-shell mode-${sidebarMode}`}>
        <Sidebar collapsed={sidebarMode === "icons"} onToggle={cycleMode} />
        <div className="main-scroll">
          <Topbar section={section} page={page} onOpenPalette={() => setPaletteOpen(true)} />
          <div className="view-pad">{children}</div>
        </div>
      </div>
      {sidebarMode === "hidden" && (
        <button className="sb-reveal" onClick={cycleMode} aria-label="Show sidebar" title="Show sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Mascot />
      <InterfaceStudioDrawer />
    </SpotifyProvider>
  );
}
