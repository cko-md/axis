"use client";

import { Skeleton } from "@/components/ui/Skeleton";
import styles from "./NotesEditor.module.css";

// Placeholder shown while the lazily-loaded TipTap editor chunk streams in
// (NOTES-1). Reuses the editor shell class so the toolbar/body geometry
// matches, avoiding a layout jump when the real editor mounts.
export function NotesEditorSkeleton() {
  return (
    <div className={styles.shell} role="status" aria-label="Loading editor">
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} width={i % 3 === 0 ? 46 : 28} height={26} borderRadius={6} />
        ))}
      </div>
      <div style={{ padding: "28px clamp(16px, 6%, 56px)", display: "flex", flexDirection: "column", gap: 14 }}>
        <Skeleton width="52%" height={26} />
        <Skeleton width="94%" height={14} />
        <Skeleton width="88%" height={14} />
        <Skeleton width="96%" height={14} />
        <Skeleton width="70%" height={14} />
        <Skeleton width="90%" height={14} />
        <Skeleton width="60%" height={14} />
      </div>
    </div>
  );
}
