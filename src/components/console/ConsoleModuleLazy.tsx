"use client";

import dynamic from "next/dynamic";

/**
 * Console includes the dashboard's drag, motion, and widget orchestration
 * stack. Keep the route shell responsive while that interactive workspace
 * arrives as its own client chunk.
 */
export const ConsoleModuleLazy = dynamic(
  () => import("./ConsoleModule").then((module) => module.ConsoleModule),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-live="polite" style={{ minHeight: 360, display: "grid", alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>Loading command workspace...</p>
      </div>
    ),
  },
);
