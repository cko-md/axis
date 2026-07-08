"use client";

import type { CSSProperties } from "react";

export type AxisLoadingSheenProps = {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  style?: CSSProperties;
};

export function AxisLoadingSheen({
  width = "100%",
  height = 16,
  borderRadius = 4,
  className = "",
  style,
}: AxisLoadingSheenProps) {
  return (
    <div
      className={`axis-loading-sheen ${className}`.trim()}
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        ...style,
      }}
    />
  );
}

