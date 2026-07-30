"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { formatClock } from "@/lib/format";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useWebViewer } from "@/lib/hooks/useWebViewer";
import type {
  AccountState,
  ProfileSaveState,
  ProfileUploadState,
} from "@/components/layout/ShellProfileContext";

type Props = {
  section: string;
  page: string;
  onOpenSearch: () => void;
  onOpenPalette: () => void;
  accountState: AccountState;
  profileSaveState: ProfileSaveState;
  profileUploadState: ProfileUploadState;
  hasPendingProfileChanges: boolean;
};

export function Topbar({
  section,
  page,
  onOpenSearch,
  onOpenPalette,
  accountState,
  profileSaveState,
  profileUploadState,
  hasPendingProfileChanges,
}: Props) {
  const [clock, setClock] = useState("");
  const { openInterfaceStudio } = useTheme();
  const { open: openBrowser } = useWebViewer();

  useEffect(() => {
    const tick = () => setClock(formatClock());
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  const syncState =
    accountState === "ready"
      ? "signed_in"
      : accountState === "signed-out"
        ? "signed_out"
        : accountState;
  const requiresMfa =
    accountState === "mfa-required" ||
    profileSaveState === "mfa-required" ||
    profileUploadState === "mfa-required";
  const syncLabel = (() => {
    if (profileUploadState === "uploading") {
      return "Uploading profile photo…";
    }
    if (profileUploadState === "error") {
      return "Profile photo upload failed";
    }
    if (requiresMfa) return "Profile not saved · Verify identity";
    if (profileSaveState === "session-expired") {
      return "Profile not saved · Sign in";
    }
    if (profileSaveState === "error") return "Profile save failed";
    if (profileSaveState === "pending" || profileSaveState === "saving") {
      return "Saving profile…";
    }
    if (hasPendingProfileChanges) return "Profile changes pending";
    if (syncState === "signed_in") return "Synced · Supabase";
    if (syncState === "signed_out") return "Local · Not signed in";
    if (syncState === "error") return "Sync unavailable";
    return "Checking sync…";
  })();
  const syncTitle = (() => {
    if (profileUploadState === "uploading") {
      return "Profile photo upload is in progress";
    }
    if (profileUploadState === "error") {
      return "Profile photo was not uploaded";
    }
    if (requiresMfa) {
      return "Complete two-factor authentication to save profile changes";
    }
    if (profileSaveState === "session-expired") {
      return "Profile changes are retained locally; sign in to save them";
    }
    if (profileSaveState === "error") {
      return "Profile changes were not saved";
    }
    if (profileSaveState === "pending" || profileSaveState === "saving") {
      return "Profile changes are waiting to be saved";
    }
    if (hasPendingProfileChanges) {
      return "Profile changes are retained but not yet saved";
    }
    if (syncState === "signed_in") return "Synced to Supabase";
    if (syncState === "signed_out") return "Local only — sign in to sync";
    if (syncState === "error") {
      return "Could not verify Supabase sync status";
    }
    return "Checking Supabase sync status";
  })();
  const syncIndicator = (
    <>
      <span
        className="dotpulse"
        style={
          syncState === "signed_in"
            ? undefined
            : { background: "var(--ink-faint)", boxShadow: "none" }
        }
      />
      {syncLabel}
    </>
  );

  return (
    <header className="topbar">
      <div className="crumb">
        <b>{section}</b> &nbsp;/&nbsp; {page}
      </div>
      <div className="clock">{clock}</div>
      {requiresMfa ? (
        <Link
          href="/login?mfa=required"
          prefetch={false}
          className="sync"
          title={syncTitle}
          role="status"
        >
          {syncIndicator}
        </Link>
      ) : (
        <div className="sync" title={syncTitle} role="status">
          {syncIndicator}
        </div>
      )}
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
