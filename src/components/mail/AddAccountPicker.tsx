"use client";

import { openComposioOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { ProviderDot } from "./ProviderBadges";

/**
 * Gmail/Outlook picker dropdown used wherever a "Connect Mail" action needs to
 * disambiguate providers before kicking off the OAuth popup flow. Shared between
 * MailModule and PeopleModule (and anywhere else mail can be connected from).
 *
 * All connections go through Composio — the app no longer ships its own Gmail/
 * Outlook OAuth client. One provider, one row, one auth path.
 */
export function AddAccountPicker({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (provider: "gmail" | "outlook") => void;
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
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "var(--glass-2)"; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "none"; },
  };
  const connect = (toolkit: "gmail" | "outlook") => {
    onClose();
    openComposioOAuthPopup(toolkit, (status) => {
      if (status === "ok") onConnected(toolkit);
    });
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        right: 0,
        zIndex: 20,
        background: "var(--surface-2)",
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "6px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 160,
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
      }}
    >
      <button type="button" onClick={() => connect("gmail")} style={rowStyle} {...hoverProps}>
        <ProviderDot provider="gmail" /> Gmail
      </button>
      <button type="button" onClick={() => connect("outlook")} style={rowStyle} {...hoverProps}>
        <ProviderDot provider="outlook" /> Outlook
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
