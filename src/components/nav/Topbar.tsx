"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useMemo, useState } from "react";
import { formatClock } from "@/lib/format";
import { useTheme } from "@/components/theme/ThemeProvider";
import { createClient } from "@/lib/supabase/client";
import { useWebViewer } from "@/lib/hooks/useWebViewer";

type Props = {
  section: string;
  page: string;
  onOpenSearch: () => void;
  onOpenPalette: () => void;
};

export function Topbar({ section, page, onOpenSearch, onOpenPalette }: Props) {
  const [clock, setClock] = useState("");
  const [syncState, setSyncState] = useState<
    "loading" | "signed_in" | "signed_out" | "error"
  >("loading");
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
    let active = true;
    void supabase.auth
      .getUser()
      .then(({ data: { user }, error }) => {
        if (!active) return;
        if (error) {
          Sentry.captureException(new Error("Topbar auth sync status failed"), {
            tags: {
              area: "topbar",
              operation: "auth_status",
              status: error.status ? String(error.status) : "unknown",
            },
          });
          setSyncState("error");
          return;
        }
        setSyncState(user ? "signed_in" : "signed_out");
      })
      .catch(() => {
        if (!active) return;
        Sentry.captureException(new Error("Topbar auth sync status network failure"), {
          tags: { area: "topbar", operation: "auth_status_network" },
        });
        setSyncState("error");
      });
    return () => {
      active = false;
    };
  }, [supabase]);

  const syncLabel =
    syncState === "signed_in"
      ? "Synced · Supabase"
      : syncState === "signed_out"
        ? "Local · Not signed in"
        : syncState === "error"
          ? "Sync unavailable"
          : "Checking sync…";
  const syncTitle =
    syncState === "signed_in"
      ? "Synced to Supabase"
      : syncState === "signed_out"
        ? "Local only — sign in to sync"
        : syncState === "error"
          ? "Could not verify Supabase sync status"
          : "Checking Supabase sync status";

  return (
    <header className="topbar">
      <div className="crumb">
        <b>{section}</b> &nbsp;/&nbsp; {page}
      </div>
      <div className="clock">{clock}</div>
      <div className="sync" title={syncTitle} role="status">
        <span
          className="dotpulse"
          style={
            syncState === "signed_in"
              ? undefined
              : { background: "var(--ink-faint)", boxShadow: "none" }
          }
        />
        {syncLabel}
      </div>
      <button
        type="button"
        className="search"
        title="Search Axis (⌘/)"
        onClick={onOpenSearch}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 16, height: 16 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <span className="srch-text">Search Axis…</span>
        <span className="kbd">⌘/</span>
      </button>
      <button
        type="button"
        className="iconbtn"
        title="Command palette (⌘K)"
        aria-label="Open command palette"
        onClick={onOpenPalette}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ width: 16, height: 16 }}>
          <path d="M7 7h10M7 12h7M7 17h4" />
        </svg>
      </button>
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
