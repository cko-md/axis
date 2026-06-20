"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body style={{ margin: 0, background: "#09090b", color: "#e8e4dc", fontFamily: "system-ui, sans-serif", display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", padding: "0 24px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".12em", color: "#555" }}>Fatal Error</div>
          <div style={{ fontSize: 14, color: "#888", maxWidth: 320, lineHeight: 1.6 }}>
            {error.message || "A critical error occurred"}
          </div>
          <button
            onClick={reset}
            style={{ marginTop: 4, padding: "6px 16px", border: "1px solid #333", borderRadius: 6, background: "transparent", color: "#e8e4dc", fontSize: 11, cursor: "pointer", letterSpacing: ".06em" }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
