"use client";

import { openOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { ProviderDot } from "@/components/mail/ProviderBadges";

/**
 * Google/Outlook Calendar picker, mirroring AddAccountPicker.tsx's pattern:
 * a primary-tier legacy direct-OAuth row per provider, plus a secondary
 * dimmer-tier "via Composio" row. Outlook's Composio connection reuses the
 * same "outlook" toolkit Mail already connects — a user with Outlook mail
 * connected via Composio already has calendar access through that same
 * connected account, no second OAuth grant required.
 */
export function AddCalendarPicker({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (provider: "google" | "outlook") => void;
}) {
  const rowStyle = (dim: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 5,
    background: "none",
    border: "none",
    color: dim ? "var(--ink-dim)" : "var(--ink)",
    fontSize: dim ? "12px" : "13px",
    cursor: "pointer",
    textAlign: "left",
  });
  const hoverProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "none"; },
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        zIndex: 20,
        background: "var(--surface, #181818)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "6px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 200,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/calendar/connect?provider=google", (_provider, status) => {
            if (status === "ok") onConnected("google");
          });
        }}
        style={rowStyle(false)}
        {...hoverProps}
      >
        <ProviderDot provider="google" /> Google Calendar
      </button>
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/calendar/connect?provider=outlook", (_provider, status) => {
            if (status === "ok") onConnected("outlook");
          });
        }}
        style={rowStyle(false)}
        {...hoverProps}
      >
        <ProviderDot provider="outlook" /> Outlook Calendar
      </button>
      <div style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/integrations/composio/connect?toolkit=googlecalendar", (_provider, status) => {
            if (status === "ok") onConnected("google");
          });
        }}
        style={rowStyle(true)}
        {...hoverProps}
      >
        <ProviderDot provider="google" /> Google Calendar (via Composio)
      </button>
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/integrations/composio/connect?toolkit=outlook", (_provider, status) => {
            if (status === "ok") onConnected("outlook");
          });
        }}
        style={rowStyle(true)}
        {...hoverProps}
      >
        <ProviderDot provider="outlook" /> Outlook Calendar (via Composio)
      </button>
      <button
        type="button"
        onClick={onClose}
        style={{
          padding: "6px 10px",
          borderRadius: 5,
          background: "none",
          border: "none",
          color: "var(--ink-dim)",
          fontSize: "12px",
          cursor: "pointer",
          textAlign: "center",
        }}
      >
        Cancel
      </button>
    </div>
  );
}
