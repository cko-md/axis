import type { LucideIcon, LucideProps } from "lucide-react";
import { resolveNavIcon } from "@/lib/icons/nav-icons";

export type IconSize = "xs" | "sm" | "md" | "lg";

const SIZE_PX: Record<IconSize, number> = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 22,
};

export type IconProps = Omit<LucideProps, "ref"> & {
  /** Lucide component or nav icon key from `nav.ts` */
  icon: LucideIcon | string;
  size?: IconSize;
  /** Accessible label — required when icon is the only control content */
  label?: string;
};

/**
 * Operational icon primitive — thin stroke, token-driven color, consistent sizing.
 * Pass a Lucide component or a nav icon key (`console`, `mail`, …).
 */
export function Icon({
  icon,
  size = "sm",
  strokeWidth = 1.6,
  className = "",
  label,
  "aria-hidden": ariaHidden,
  ...props
}: IconProps) {
  const Cmp = typeof icon === "string" ? resolveNavIcon(icon) : icon;
  const px = SIZE_PX[size];
  const decorative = ariaHidden ?? !label;

  return (
    <Cmp
      size={px}
      strokeWidth={strokeWidth}
      className={`shrink-0 ${className}`}
      aria-hidden={decorative || undefined}
      aria-label={label}
      role={label ? "img" : undefined}
      {...props}
    />
  );
}
