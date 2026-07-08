import { ALL_NAV_ITEMS } from "@/lib/store/nav";

// Pure model for the ⌘K command palette. Kept out of the component so command
// coverage (every nav route + the core create actions) is unit-testable and a
// guard test can fail CI if a route ships without a palette entry (DISP-4).

export type PaletteGroup = "navigate" | "action" | "create";

export type PaletteTarget =
  | { kind: "route"; href: string }
  | { kind: "interface-studio" };

export type PaletteCommandSpec = {
  id: string;
  label: string;
  hint: string;
  group: PaletteGroup;
  icon?: string;
  target: PaletteTarget;
};

// Core create actions the palette must always expose (audit requirement:
// new note / task / signal reachable from ⌘K).
export const PALETTE_CREATE_COMMANDS: PaletteCommandSpec[] = [
  { id: "create-note", label: "New Note", hint: "Create · notes", group: "create", icon: "create", target: { kind: "route", href: "/notes" } },
  { id: "create-task", label: "New Task", hint: "Create · agenda", group: "create", icon: "create", target: { kind: "route", href: "/agenda" } },
  { id: "create-event", label: "New Event", hint: "Create · schedule", group: "create", icon: "create", target: { kind: "route", href: "/schedule" } },
  { id: "create-signal", label: "New Signal", hint: "Create · dispatch", group: "create", icon: "create", target: { kind: "route", href: "/dispatch" } },
];

export const PALETTE_ACTION_COMMANDS: PaletteCommandSpec[] = [
  { id: "action-interface-studio", label: "Interface Studio", hint: "Action · theme & appearance", group: "action", icon: "palette", target: { kind: "interface-studio" } },
  { id: "action-vitality", label: "Log Workout", hint: "Action · vitality", group: "action", icon: "fitness", target: { kind: "route", href: "/vitality" } },
];

// Full command set: create + action + one navigate command per nav route.
export function buildPaletteCommandSpecs(): PaletteCommandSpec[] {
  return [
    ...PALETTE_CREATE_COMMANDS,
    ...PALETTE_ACTION_COMMANDS,
    ...ALL_NAV_ITEMS.map<PaletteCommandSpec>((item) => ({
      id: item.href,
      label: item.label,
      hint: `Navigate · ${item.section}`,
      group: "navigate",
      icon: item.icon,
      target: { kind: "route", href: item.href },
    })),
  ];
}

// Case-insensitive match over label, hint, and group — mirrors the palette's
// interactive filter.
export function filterPaletteCommandSpecs<T extends Pick<PaletteCommandSpec, "label" | "hint" | "group">>(
  specs: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return specs;
  return specs.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      c.hint.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q),
  );
}
