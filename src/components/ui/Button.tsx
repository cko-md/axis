"use client";

import React, { type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:   "btn-primary",
  secondary: "btn-secondary",
  ghost:     "bg-transparent border-none text-[var(--ink-dim)] hover:text-[var(--accent)] px-3 py-2",
  danger:    "btn-secondary text-[var(--down)] hover:text-[var(--down)]",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
};

export function Button({
  variant = "secondary",
  loading,
  className = "",
  children,
  disabled,
  ...props
}: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 text-xs font-medium transition disabled:opacity-50 ${loading ? "[&>svg:not(.axis-button-spinner)]:hidden" : ""} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Loader2 size={14} strokeWidth={1.6} className="axis-button-spinner shrink-0" aria-hidden /> : null}
      {children}
    </button>
  );
}
