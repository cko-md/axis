"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  title: string;
  url: string;
  onClose: () => void;
};

/**
 * Near-fullscreen popout for URL-added modules (Step 2 CK Bank, etc.) and the
 * integrated browser. Embeds the target in an iframe; because many sites send
 * X-Frame-Options/CSP frame-ancestors that block embedding, a graceful
 * "open in new tab" fallback is always one click away. Closes on ✕, backdrop, Esc.
 */
export function ExternalWindow({ title, url, onClose }: Props) {
  const [blocked, setBlocked] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // If the iframe hasn't signalled load shortly, assume the host refused to embed.
  useEffect(() => {
    setBlocked(false);
    setLoaded(false);
    const t = setTimeout(() => setLoaded((l) => (l ? l : (setBlocked(true), true))), 3500);
    return () => clearTimeout(t);
  }, [url]);

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="overlay on" onClick={onClose}>
      <div className="appwin" onClick={(e) => e.stopPropagation()}>
        <div className="appwin-bar">
          <div className="dots">
            <i />
            <i />
            <i />
          </div>
          <div className="at">{title.toUpperCase()}</div>
          <div className="url" title={url}>
            {url}
          </div>
          <button
            type="button"
            className="open-ext"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            Open ↗
          </button>
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {blocked ? (
          <div className="iframe-fallback">
            <div>
              <div className="glyph" style={{ width: 58, height: 58, border: "1px solid var(--gold)", borderRadius: "var(--rl)", display: "grid", placeItems: "center", color: "var(--gold)", margin: "0 auto 16px" }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 26, height: 26 }}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" />
                </svg>
              </div>
              <p style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--ink)" }}>{host}</strong> won&rsquo;t embed here.
              </p>
              <p style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 18 }}>
                The site blocks framing. Open it in a dedicated tab instead.
              </p>
              <button
                type="button"
                className="open-ext"
                style={{ fontSize: 11, padding: "8px 16px" }}
                onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
              >
                Open {host} ↗
              </button>
            </div>
          </div>
        ) : (
          <iframe
            src={url}
            title={title}
            onLoad={() => {
              setLoaded(true);
              setBlocked(false);
            }}
            referrerPolicy="no-referrer"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
