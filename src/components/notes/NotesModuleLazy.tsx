"use client";

import dynamic from "next/dynamic";

/**
 * Notes carries drag-and-drop, search, AI routing, recording, and editor
 * orchestration. Keep the shared shell interactive while that workspace loads.
 */
export const NotesModuleLazy = dynamic(
  () => import("./NotesModule").then((module) => module.NotesModule),
  {
    ssr: false,
    loading: () => (
      <div role="status" aria-live="polite" style={{ minHeight: 360, display: "grid", alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>Loading notes workspace...</p>
      </div>
    ),
  },
);
