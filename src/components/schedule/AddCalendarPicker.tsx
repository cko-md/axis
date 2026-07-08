"use client";

import { openComposioOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { ProviderDot } from "@/components/mail/ProviderBadges";

/**
 * Google/Outlook Calendar picker. All connections go through Composio — the app
 * no longer ships its own Calendar OAuth client. Google Calendar uses the
 * `googlecalendar` toolkit; Outlook Calendar reuses the same `outlook` toolkit
 * Mail connects (one connected account grants both mail + calendar access).
 */
export function AddCalendarPicker({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (provider: "google" | "outlook") => void;
}) {
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 5,
    background: "none",
    border: "none",
    color: "var(--ink)",
    fontSize: "13px",
    cursor: "pointer",
    textAlign: "left",
  };
  const hoverProps = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "none"; },
  };
  const connect = (toolkit: "googlecalendar" | "outlook", provider: "google" | "outlook") => {
    onClose();
    openComposioOAuthPopup(toolkit, (status) => {
      if (status === "ok") onConnected(provider);
    });
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
      <button type="button" onClick={() => connect("googlecalendar", "google")} style={rowStyle} {...hoverProps}>
        <ProviderDot provider="google" /> Google Calendar
      </button>
      <button type="button" onClick={() => connect("outlook", "outlook")} style={rowStyle} {...hoverProps}>
        <ProviderDot provider="outlook" /> Outlook Calendar
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
