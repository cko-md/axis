import type { WidgetCatalogItem } from "@/lib/types";

export const WIDGET_CATALOG: WidgetCatalogItem[] = [
  // ── environmental ──────────────────────────────────────────────
  { id: "weather",   icon: "☀︎", label: "Weather",       value: "Setup required",      hint: "Enable location or configure defaults", category: "Environment", live: true },
  { id: "daylight",  icon: "◷", label: "Daylight",       value: "Setup required",      hint: "Uses location when available",          category: "Environment", live: true },
  { id: "air",       icon: "▴", label: "Air Quality",    value: "Setup required",      hint: "Uses location when available",          category: "Environment", live: true },
  // ── schedule & tasks ───────────────────────────────────────────
  { id: "agenda",    icon: "◔", label: "Agenda",         value: "No agenda data",      hint: "Connect Schedule and add tasks",        category: "Schedule", live: true },
  // ── finance ────────────────────────────────────────────────────
  { id: "markets",   icon: "◈", label: "Markets",        value: "Setup required",      hint: "Configure market data provider",        category: "Finance", live: true },
  // ── fitness & health ───────────────────────────────────────────
  { id: "run",       icon: "◉", label: "Training",       value: "Connect Strava",      hint: "Training appears after connection",     category: "Health", live: true },
  { id: "sleep",     icon: "◐", label: "Sleep",          value: "Lab",                 hint: "Demo only until wearable sync ships",   category: "Health", live: false },
  { id: "hrv",       icon: "♡", label: "HRV",            value: "Lab",                 hint: "Demo only until wearable sync ships",   category: "Health", live: false },
  { id: "heartrate", icon: "◎", label: "Resting HR",     value: "Lab",                 hint: "Demo only until wearable sync ships",   category: "Health", live: false },
  { id: "vo2max",    icon: "◇", label: "VO₂ Max",        value: "Lab",                 hint: "Demo only until wearable sync ships",   category: "Health", live: false },
  // ── creative & notes ───────────────────────────────────────────
  { id: "hydration", icon: "○", label: "Hydration",      value: "Lab",                 hint: "Manual hydration tracking not live",    category: "Wellness", live: false },
  { id: "location",  icon: "◻", label: "Location",       value: "Setup required",      hint: "Enable location services",             category: "Environment", live: true },
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
  /** 1-based grid column start (4-col grid). Lets blocks sit right on a row. */
  columns?: Record<string, number>;
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
): { order: string[]; sizes: Record<string, BlockSize>; columns: Record<string, number> } | null {
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

  let columns: Record<string, number> | null = null;
  if (blob.columns && typeof blob.columns === "object") {
    const out: Record<string, number> = {};
    for (const [id, col] of Object.entries(blob.columns)) {
      if (known.has(id) && typeof col === "number" && col >= 1 && col <= 4) out[id] = col;
    }
    if (Object.keys(out).length > 0) columns = out;
  }

  if (!order && !sizes && !columns) return null;
  return { order: order ?? [...defaultOrder], sizes: sizes ?? {}, columns: columns ?? {} };
}
