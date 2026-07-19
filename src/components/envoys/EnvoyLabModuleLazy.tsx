"use client";

import dynamic from "next/dynamic";

/** Envoy Lab is interactive client-only work; keep it out of the route shell. */
export const EnvoyLabModuleLazy = dynamic(
  () => import("./EnvoyLabModule").then((module) => module.EnvoyLabModule),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        style={{ minHeight: 360, display: "grid", alignItems: "center" }}
      >
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>
          Opening Envoy Lab...
        </p>
      </div>
    ),
  },
);
