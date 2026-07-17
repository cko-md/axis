"use client";

import dynamic from "next/dynamic";

/**
 * IndexedDB, checksum, and sync orchestration are client-only platform work.
 * Keep them out of the lobby's route-critical shell and load them together.
 */
export const VectorLobbyPlatformLazy = dynamic(
  () => import("./VectorLobbyPlatform").then((module) => module.VectorLobbyPlatform),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        style={{ minHeight: 360, display: "grid", alignItems: "center" }}
      >
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>
          Opening owner-scoped VECTOR storage...
        </p>
      </div>
    ),
  },
);
