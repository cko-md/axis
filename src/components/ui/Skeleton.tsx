import React from "react";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = "100%", height = 16, borderRadius = 4, className, style }: SkeletonProps) {
  return (
    <div
      className={className}
      style={{
        width,
        height,
        borderRadius,
        background: "var(--surface-2)",
        overflow: "hidden",
        position: "relative",
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(90deg, transparent 0%, var(--line) 50%, transparent 100%)",
          animation: "skeleton-shimmer 1.4s ease-in-out infinite",
          transform: "translateX(-100%)",
        }}
      />
      <style>{`
        @keyframes skeleton-shimmer {
          to { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, border: "1px solid var(--line)", borderRadius: "var(--rl)", background: "var(--surface)" }}>
      <Skeleton height={14} width="60%" />
      {Array.from({ length: rows - 1 }).map((_, i) => (
        <Skeleton key={i} height={12} width={i % 2 === 0 ? "90%" : "75%"} />
      ))}
    </div>
  );
}
