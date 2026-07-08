"use client";

import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  className?: string;
};

export function AxisReflectiveCard({ className = "", children, ...rest }: Props) {
  return (
    <div className={`axis-reflective-card ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

