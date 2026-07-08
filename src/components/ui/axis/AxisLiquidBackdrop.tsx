"use client";

import type { HTMLAttributes } from "react";
import { AxisAtmosphere } from "./AxisAtmosphere";

type Props = HTMLAttributes<HTMLDivElement> & {
  includeStars?: boolean;
};

export function AxisLiquidBackdrop({ className = "", includeStars = false, ...rest }: Props) {
  return <AxisAtmosphere className={className} includeStars={includeStars} {...rest} />;
}

