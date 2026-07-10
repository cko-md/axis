"use client";

import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  className?: string;
};

export function AxisChromePanel({ className = "", children, ...rest }: Props) {
  return (
    <div className={`axis-chrome-panel ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}

