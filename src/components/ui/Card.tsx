import type { HTMLAttributes } from "react";

type Variant = "default" | "quote" | "ctx" | "devo" | "paper";

type Props = HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
  tick?: boolean;
};

const variantClass: Record<Variant, string> = {
  default: "",
  quote:   "quote-card",
  ctx:     "ctx-card",
  devo:    "devo",
  paper:   "paper-feature",
};

export function Card({ variant = "default", tick = false, className = "", children, ...rest }: Props) {
  return (
    <div
      className={`card ${variantClass[variant]} ${tick ? "tick" : ""} ${className}`.trim()}
      {...rest}
    >
      {children}
    </div>
  );
}
