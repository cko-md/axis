"use client";

import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  className?: string;
};

export function AxisGlassPanel({ className = "", children, ...rest }: Props) {
  return (
    <div className={`axis-glass-panel ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

