"use client";

import { openOAuthPopup } from "@/lib/auth/openOAuthPopup";

/**
 * Google Contacts picker. The connection goes through Composio — the app no
 * longer ships its own Contacts OAuth client. Google is the only Contacts
 * provider today, so this is a single-row picker.
 */
export function AddContactsPicker({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: () => void;
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
          openOAuthPopup("/api/integrations/composio/connect?toolkit=googlecontacts", (_provider, status) => {
            if (status === "ok") onConnected();
          });
        }}
        style={rowStyle}
        {...hoverProps}
      >
        Google Contacts
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
