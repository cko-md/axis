"use client";

import { openOAuthPopup } from "@/lib/auth/openOAuthPopup";

/**
 * Google Contacts picker, mirroring AddAccountPicker.tsx's pattern: a
 * primary-tier legacy direct-OAuth row, plus a secondary dimmer-tier "via
 * Composio" row. Only one provider (Google) exists for Contacts today, so
 * this is a 2-row picker rather than AddAccountPicker's provider x path grid.
 */
export function AddContactsPicker({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
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
          openOAuthPopup("/api/contacts/connect", (_provider, status) => {
            if (status === "ok") onConnected();
          });
        }}
        style={rowStyle(false)}
        {...hoverProps}
      >
        Google Contacts
      </button>
      <div style={{ height: 1, background: "var(--line)", margin: "4px 2px" }} />
      <button
        type="button"
        onClick={() => {
          onClose();
          openOAuthPopup("/api/integrations/composio/connect?toolkit=googlecontacts", (_provider, status) => {
            if (status === "ok") onConnected();
          });
        }}
        style={rowStyle(true)}
        {...hoverProps}
      >
        Google Contacts (via Composio)
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
