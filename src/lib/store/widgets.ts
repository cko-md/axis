import type { WidgetCatalogItem } from "@/lib/types";

export const WIDGET_CATALOG: WidgetCatalogItem[] = [
  // ── environmental ──────────────────────────────────────────────
  { id: "weather",   icon: "☀︎", label: "Weather",       value: "61°F · Clear",        hint: "Tarrytown · ideal run window 7–9a",    category: "Environment" },
  { id: "daylight",  icon: "◷", label: "Daylight",       value: "14h 27m daylight",    hint: "Sunset 8:14p · golden hour 7:30p",    category: "Environment" },
  { id: "air",       icon: "▴", label: "Air Quality",    value: "AQI 22 · Good",       hint: "UV 6 · sunscreen for long run",        category: "Environment" },
  // ── schedule & tasks ───────────────────────────────────────────
  { id: "agenda",    icon: "◔", label: "Agenda",         value: "3 events · 5 tasks",  hint: "Next: DBS edits in 1h 48m",            category: "Schedule" },
  // ── finance ────────────────────────────────────────────────────
  { id: "markets",   icon: "◈", label: "Markets",        value: "S&P ▴0.31%",          hint: "Portfolio ▴1.24% today",               category: "Finance" },
  // ── fitness & health ───────────────────────────────────────────
  { id: "run",       icon: "◉", label: "Training",       value: "8 km banked",         hint: "Streak day 8 · Strava",                category: "Health" },
  { id: "sleep",     icon: "◐", label: "Sleep",          value: "7h 24m",              hint: "82% efficiency · well-rested",         category: "Health" },
  { id: "hrv",       icon: "♡", label: "HRV",            value: "86 ms",               hint: "Above baseline · recovery: good",      category: "Health" },
  { id: "heartrate", icon: "◎", label: "Resting HR",     value: "48 bpm",              hint: "Well-recovered · 5-day low",           category: "Health" },
  { id: "vo2max",    icon: "◇", label: "VO₂ Max",        value: "54 mL/kg",            hint: "Excellent · top 10% for age",          category: "Health" },
  // ── creative & notes ───────────────────────────────────────────
  { id: "hydration", icon: "○", label: "Hydration",      value: "2 of 4 glasses",      hint: "Warm afternoon ahead",                 category: "Wellness" },
  { id: "location",  icon: "◻", label: "Location",       value: "Tarrytown, NY",       hint: "EST · home base",                      category: "Environment" },
];

export const DEFAULT_WIDGET_IDS = ["run", "daylight", "agenda", "air"];

export function getWidgetById(id: string): WidgetCatalogItem {
  return WIDGET_CATALOG.find((w) => w.id === id) ?? WIDGET_CATALOG[0];
}

export const WIDGET_CATEGORIES = ["Environment", "Schedule", "Finance", "Health", "Wellness"] as const;
export type WidgetCategory = (typeof WIDGET_CATEGORIES)[number];

/* ── console module (section) layout ─────────────────────────────── */

export type BlockSize = "sm" | "md" | "full";
export const BLOCK_SIZES: readonly BlockSize[] = ["sm", "md", "full"];

/**
 * Structured layout for the freeform dashboard grid.
 *  - `order`: section render order (drag-to-rearrange).
 *  - `sizes`: per-section grid span — "sm" is a one-column slot, "md" spans two
 *    columns (on the 4-col grid), "full" spans the entire row. Cards snap to
 *    these slots so the packing stays structured (no overlaps), while still
 *    being draggable to any slot they fit.
 *
 * Persisted to the `console_widgets.layout` jsonb column and auto-saved
 * (debounced) on drag-end. Both keys are optional so a partially-populated or
 * absent blob degrades gracefully to the caller's defaults.
 */
export type ConsoleLayout = {
  order?: string[];
  sizes?: Record<string, BlockSize>;
};

/**
 * Normalize an arbitrary stored layout against the known section ids:
 *  - keeps only known ids, in stored order, then appends any defaults that were
 *    missing (so newly-added sections always surface).
 *  - filters sizes down to known ids with valid values.
 * Returns null when `raw` carries no usable order/sizes, so callers can fall
 * back to localStorage / default order.
 */
export function normalizeConsoleLayout(
  raw: unknown,
  defaultOrder: readonly string[],
): { order: string[]; sizes: Record<string, BlockSize> } | null {
  if (!raw || typeof raw !== "object") return null;
  const blob = raw as ConsoleLayout;
  const known = new Set(defaultOrder);

  let order: string[] | null = null;
  if (Array.isArray(blob.order) && blob.order.length > 0) {
    const seen = new Set<string>();
    const kept = blob.order.filter((id) => known.has(id) && !seen.has(id) && (seen.add(id), true));
    const missing = defaultOrder.filter((id) => !seen.has(id));
    order = [...kept, ...missing];
  }

  let sizes: Record<string, BlockSize> | null = null;
  if (blob.sizes && typeof blob.sizes === "object") {
    const out: Record<string, BlockSize> = {};
    for (const [id, size] of Object.entries(blob.sizes)) {
      if (known.has(id) && (BLOCK_SIZES as string[]).includes(size as string)) out[id] = size as BlockSize;
    }
    if (Object.keys(out).length > 0) sizes = out;
  }

  if (!order && !sizes) return null;
  return { order: order ?? [...defaultOrder], sizes: sizes ?? {} };
}
