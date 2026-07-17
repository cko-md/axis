"use client";

import dynamic from "next/dynamic";
import type { VectorGameSlug } from "@/lib/vector/types";

/**
 * Game persistence/runtime orchestration is intentionally outside the route
 * shell. Future engine loaders remain a second, game-specific dynamic boundary.
 */
export const VectorGamePlatformLazy = dynamic<{ gameId: VectorGameSlug }>(
  () => import("./VectorGamePlatform").then((module) => module.VectorGamePlatform),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        style={{ minHeight: 360, display: "grid", alignItems: "center" }}
      >
        <p style={{ margin: 0, color: "var(--ink-faint)", fontSize: 12 }}>
          Opening owner-scoped game storage...
        </p>
      </div>
    ),
  },
);
