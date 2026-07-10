import type React from "react";
import { AxisLoadingSheen } from "./axis/AxisLoadingSheen";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = "100%", height = 16, borderRadius = 4, className, style }: SkeletonProps) {
  return (
    <AxisLoadingSheen
      width={width}
      height={height}
      borderRadius={borderRadius}
      className={className}
      style={style}
    />
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
