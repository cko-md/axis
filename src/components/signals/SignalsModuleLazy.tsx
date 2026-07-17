"use client";

import dynamic from "next/dynamic";

/** Keep the shared shell responsive while the interactive signals workspace loads. */
export const SignalsModuleLazy = dynamic(
  () => import("./SignalsModule").then((module) => module.SignalsModule),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-live="polite" style={{ minHeight: 360, display: "grid", alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>Loading dispatch workspace...</p>
      </div>
    ),
  },
);
