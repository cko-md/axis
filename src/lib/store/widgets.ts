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
