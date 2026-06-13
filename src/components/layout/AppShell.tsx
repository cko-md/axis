"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Sidebar } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { CommandPalette } from "@/components/nav/CommandPalette";
import { Mascot } from "@/components/layout/Mascot";
import { InterfaceStudioDrawer } from "@/components/theme/InterfaceStudioDrawer";
import { SpotifyProvider } from "@/components/spotify/SpotifyProvider";

type Props = {
  section: string;
  page: string;
  children: ReactNode;
};

export function AppShell({ section, page, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  return (
    <SpotifyProvider>
      <div className="depthfield" aria-hidden>
        <div className="wash" /><div className="aurora" /><div className="aurora2" />
        <div className="haze" /><div className="fall" /><div className="vig" />
      </div>
      <div className="grain" aria-hidden />
      <div className={`app-shell${collapsed ? " collapsed" : ""}`}>
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        <div className="main-scroll">
          <Topbar section={section} page={page} onOpenPalette={() => setPaletteOpen(true)} />
          <div className="view-pad">{children}</div>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Mascot />
      <InterfaceStudioDrawer />
    </SpotifyProvider>
  );
}
