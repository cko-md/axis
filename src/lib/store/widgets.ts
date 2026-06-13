import type { WidgetCatalogItem } from "@/lib/types";

export const WIDGET_CATALOG: WidgetCatalogItem[] = [
  { id: "weather", icon: "☀︎", label: "Weather", value: "61°F · Clear", hint: "Tarrytown · ideal run window 7–9a" },
  { id: "daylight", icon: "◷", label: "Daylight", value: "14h 27m daylight", hint: "Sunset 8:14p · golden hour 7:30p" },
  { id: "agenda", icon: "◔", label: "Agenda", value: "3 events · 5 tasks", hint: "Next: DBS edits in 1h 48m" },
  { id: "air", icon: "▴", label: "Air Quality", value: "AQI 22 · Good", hint: "UV 6 · sunscreen for long run" },
  { id: "markets", icon: "📈", label: "Markets", value: "S&P ▴0.31%", hint: "Portfolio ▴1.24% today" },
  { id: "run", icon: "🏃", label: "Training", value: "8 km banked", hint: "Streak day 8 · Strava" },
  { id: "hydration", icon: "💧", label: "Hydration", value: "2 of 4 glasses", hint: "Warm afternoon ahead" },
  { id: "location", icon: "📍", label: "Location", value: "Tarrytown, NY", hint: "EST · home base" },
];

export const DEFAULT_WIDGET_IDS = ["weather", "daylight", "agenda", "air"];

export function getWidgetById(id: string): WidgetCatalogItem {
  return WIDGET_CATALOG.find((w) => w.id === id) ?? WIDGET_CATALOG[0];
}
