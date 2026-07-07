"use client";

import { useEffect, useMemo, useState } from "react";
import { formatClock } from "@/lib/format";
import { useTheme } from "@/components/theme/ThemeProvider";
import { createClient } from "@/lib/supabase/client";
import { useWebViewer } from "@/lib/hooks/useWebViewer";

type Props = {
  section: string;
  page: string;
  onOpenPalette: () => void;
};

export function Topbar({ section, page, onOpenPalette }: Props) {
  const [clock, setClock] = useState("");
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const { openInterfaceStudio } = useTheme();
  const supabase = useMemo(() => createClient(), []);
  const { open: openBrowser } = useWebViewer();

  useEffect(() => {
    const tick = () => setClock(formatClock());
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setSignedIn(!!user));
  }, [supabase]);

  return (
    <header className="topbar">
      <div className="crumb">
        <b>{section}</b> &nbsp;/&nbsp; {page}
      </div>
      <div className="clock">{clock}</div>
      <div className="sync" title={signedIn ? "Synced to Supabase" : "Local only — sign in to sync"}>
        <span className="dotpulse" style={signedIn === false ? { background: "var(--ink-faint)" } : undefined} />
        {signedIn === false ? "Local · Not signed in" : "Synced · Supabase"}
      </div>
      <div
        className="search"
        role="button"
        tabIndex={0}
        title="Search or Command (⌘K)"
        onClick={onOpenPalette}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenPalette()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 16, height: 16 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <span className="srch-text">Search or Command…</span>
        <span className="kbd">⌘K</span>
      </div>
      <button type="button" className="iconbtn" title="Mini Browser" onClick={() => openBrowser("", "New Tab")}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ width: 16, height: 16 }}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" />
        </svg>
      </button>
      <button type="button" className="iconbtn" onClick={openInterfaceStudio} title="Interface Studio">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ width: 16, height: 16 }}>
          <path d="M4 20h4L18 10l-4-4L4 16zM14 6l4 4" />
        </svg>
      </button>
    </header>
  );
}
