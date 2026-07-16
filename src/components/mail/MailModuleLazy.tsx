"use client";

import dynamic from "next/dynamic";

/**
 * Mail includes account orchestration, message actions, and compose/detail
 * flows. Keep the route shell responsive while that client workspace loads.
 */
export const MailModuleLazy = dynamic(
  () => import("./MailModule").then((module) => module.MailModule),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-live="polite" style={{ minHeight: 360, display: "grid", alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>Loading mail workspace...</p>
      </div>
    ),
  },
);
