"use client";

import dynamic from "next/dynamic";

/**
 * Archive Bay is desktop-only interactive work (Electron bridge detection,
 * local library state); keep it out of the route-critical shell like every
 * other VECTOR workspace.
 */
export const ArchiveBayModuleLazy = dynamic(
  () => import("./ArchiveBayModule").then((module) => module.ArchiveBayModule),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        style={{ minHeight: 360, display: "grid", alignItems: "center" }}
      >
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>
          Opening Archive Bay...
        </p>
      </div>
    ),
  },
);
