"use client";

/** Segmented control — shared by Interface Studio drawer and Control Room. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? "on" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
