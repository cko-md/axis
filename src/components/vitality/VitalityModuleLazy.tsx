"use client";

import dynamic from "next/dynamic";

/**
 * Vitality is a multi-tab client workspace with route maps and two substantial
 * modal flows. Load that interaction bundle after the shared app shell paints.
 */
export const VitalityModuleLazy = dynamic(
  () => import("./VitalityModule").then((module) => module.VitalityModule),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-live="polite" style={{ minHeight: 360, display: "grid", alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>Loading vitality workspace...</p>
      </div>
    ),
  },
);
