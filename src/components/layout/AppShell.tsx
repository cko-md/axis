"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
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
  const autoCollapsedRef = useRef(false);

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

  // Auto-collapse sidebar on narrow viewports, and restore it when the
  // viewport widens back out — but only if the collapse was automatic
  // (a manual toggle via cycleMode sticks across resizes).
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      if (w < 600) {
        setSidebarMode((m) => {
          if (m === "open" || m === "icons") {
            autoCollapsedRef.current = true;
            return "hidden";
          }
          return m;
        });
      } else if (w < 860) {
        setSidebarMode((m) => {
          if (m === "open") {
            autoCollapsedRef.current = true;
            return "icons";
          }
          return m;
        });
      } else if (autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setSidebarMode("open");
      }
    };
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cycleMode = () => {
    autoCollapsedRef.current = false;
    setSidebarMode((m) => NEXT_MODE[m]);
  };

  return (
    <SpotifyProvider>
      <div className="depthfield" aria-hidden>
        <div className="wash" /><div className="aurora" /><div className="aurora2" />
        <div className="haze" /><div className="fall" /><div className="vig" />
        {isNight && <div className="stars" />}
      </div>
      <div className="grain" aria-hidden />
      <div className={`app-shell mode-${sidebarMode}`}>
        <Sidebar collapsed={sidebarMode === "icons"} />
        <div className="main-scroll">
          <Topbar section={section} page={page} onOpenPalette={() => setPaletteOpen(true)} />
          <main id="main-content" className="view-pad">{children}</main>
        </div>
        {/* Single sidebar toggle — rendered inside .app-shell so it can read the
            --sb-w grid variable and ride the sidebar's right edge as it resizes
            (open → icons → hidden). position:fixed keeps it out of the grid flow
            and out of the .sb-top header, so it never overlaps the AXIS logo. */}
        <button
          className="sb-toggle"
          onClick={cycleMode}
          aria-label={sidebarMode === "hidden" ? "Show sidebar" : "Collapse sidebar"}
          title={sidebarMode === "hidden" ? "Show sidebar" : "Collapse sidebar"}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            style={{ width: 14, height: 14, transform: sidebarMode === "open" ? undefined : "rotate(180deg)" }}
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <Mascot />
      <InterfaceStudioDrawer />
    </SpotifyProvider>
  );
}
