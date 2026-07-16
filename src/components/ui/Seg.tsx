"use client";

import React from "react";

type SegAccessibleName =
  | { ariaLabel: string; "aria-labelledby"?: never }
  | { ariaLabel?: never; "aria-labelledby": string };

type SegProps<T extends string> = {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
} & SegAccessibleName;

/** Segmented control — shared by Interface Studio drawer and Control Room. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SegProps<T>) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? "on" : ""}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
