"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/nav/Sidebar";
import { Topbar } from "@/components/nav/Topbar";
import { SpotifyProvider } from "@/components/spotify/SpotifyProvider";
import { AxisAtmosphere } from "@/components/ui/axis/AxisAtmosphere";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";

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

const SIDEBAR_PREF_KEY = "axis-sidebar";

function loadSidebarPreference(): Exclude<SidebarMode, "hidden"> {
  if (typeof window === "undefined") return "open";
  try {
    return window.localStorage.getItem(SIDEBAR_PREF_KEY) === "icons" ? "icons" : "open";
  } catch {
    return "open";
  }
}

function saveSidebarPreference(mode: Exclude<SidebarMode, "hidden">) {
  try {
    window.localStorage.setItem(SIDEBAR_PREF_KEY, mode);
  } catch {
    // Device preferences are best-effort; the control still works in memory.
  }
}

export function AppShell({ section, page, children }: Props) {
  const pathname = usePathname();
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("open");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isNight, setIsNight] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const autoCollapsedRef = useRef(false);
  const desktopPreferenceRef = useRef<Exclude<SidebarMode, "hidden">>("open");
  const navStatus = ALL_NAV_ITEMS.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

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
    const preference = loadSidebarPreference();
    desktopPreferenceRef.current = preference;
    if (window.innerWidth >= 860) setSidebarMode(preference);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
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
        setSidebarMode(desktopPreferenceRef.current);
      }
    };
    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cycleMode = () => {
    autoCollapsedRef.current = false;
    setSidebarMode((mode) => {
      const next = mode === "open" ? "icons" : "open";
      desktopPreferenceRef.current = next;
      saveSidebarPreference(next);
      return next;
    });
  };

  return (
    <SpotifyProvider>
      <AxisAtmosphere includeStars={isNight && !reduceMotion} />
      <div className="grain" aria-hidden />
      <div className={`app-shell mode-${sidebarMode}`}>
        <Sidebar collapsed={sidebarMode === "icons"} />
        <div className="main-scroll">
          <Topbar section={section} page={page} onOpenPalette={() => setPaletteOpen(true)} />
          <main id="main-content" className="view-pad">
            {navStatus && navStatus.status && navStatus.status !== "production" && (
              <section className={`module-status module-status-${navStatus.status}`} aria-label={`${navStatus.label} ${navStatus.status} status`}>
                <div>
                  <div className="module-status-kicker">{navStatus.status === "lab" ? "Lab module" : "Beta module"}</div>
                  <strong>{navStatus.label} is intentionally marked non-production.</strong>
                  {navStatus.statusReason && <p>{navStatus.statusReason}</p>}
                </div>
                {navStatus.statusAction && <span>{navStatus.statusAction}</span>}
              </section>
            )}
            {children}
          </main>
        </div>
        {/* Single sidebar toggle — rendered inside .app-shell so it can read the
            --sb-w grid variable and ride the sidebar's right edge as it resizes
            (open → icons → hidden). position:fixed keeps it out of the grid flow
            and out of the .sb-top header, so it never overlaps the AXIS logo. */}
        <button
          className="sb-toggle"
          onClick={cycleMode}
          aria-label={sidebarMode === "open" ? "Collapse sidebar to icons" : "Expand sidebar"}
          aria-expanded={sidebarMode === "open"}
          title={sidebarMode === "open" ? "Collapse sidebar" : "Expand sidebar"}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="sb-toggle-icon"
            style={{ transform: sidebarMode === "open" ? undefined : "rotate(180deg)" }}
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
