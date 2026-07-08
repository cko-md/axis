"use client";

import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  includeStars?: boolean;
};

export function AxisAtmosphere({ className = "", includeStars = false, ...rest }: Props) {
  return (
    <div className={`depthfield axis-atmosphere ${className}`.trim()} aria-hidden="true" {...rest}>
      <div className="wash" />
      <div className="aurora" />
      <div className="aurora2" />
      <div className="haze" />
      <div className="fall" />
      <div className="vig" />
      {includeStars ? <div className="stars" /> : null}
    </div>
  );
}

