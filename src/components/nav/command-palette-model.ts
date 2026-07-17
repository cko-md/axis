import type { ActionClass } from "@/lib/security/actionPolicy";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";

/**
 * Pure command registry for the command palette.
 *
 * The registry describes what a command is allowed to do; the client remains
 * responsible for resolving contextual availability and executing the target.
 * Keeping policy metadata here makes navigation, local workspace controls, and
 * durable mutations distinguishable before any handler runs.
 */

export type PaletteGroup = "navigate" | "action" | "create";

export type PaletteCommandScope =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspace: "split-pane" };

export type PalettePermission = Readonly<{
  authentication: "required";
  /** Durable owner data must be checked again by the server-side action. */
  ownership: "not-applicable" | "server-enforced";
}>;

export type PaletteExecutionKind = "navigation" | "client-action" | "mutation";

export type PaletteAnalyticsEvent =
  | "command_palette.navigation_selected"
  | "command_palette.create_surface_opened"
  | "command_palette.client_action_selected"
  | "command_palette.workspace_action_selected"
  | "command_palette.mutation_requested";

export type PaletteAvailabilityRequirement =
  | "workspace-shell"
  | "active-pane"
  | "multiple-panes";

export type PaletteAvailability =
  | { readonly kind: "available" }
  | {
      readonly kind: "contextual";
      readonly requires: readonly PaletteAvailabilityRequirement[];
      readonly unavailableReason: string;
    };

export type PaletteWorkspaceAction =
  | "focus-next-pane"
  | "close-active-pane"
  | "reset-pane-widths";

export type PaletteTarget =
  | {
      readonly kind: "route";
      readonly href: string;
      /** A create-surface route opens a workflow; it does not claim a record was created. */
      readonly intent: "navigate" | "open-create-surface";
    }
  | { readonly kind: "interface-studio" }
  | {
      readonly kind: "run-routine";
      readonly routine: string;
      /** Destination to open only after the mutation has returned successfully. */
      readonly href: string;
    }
  | {
      readonly kind: "workspace-action";
      readonly action: PaletteWorkspaceAction;
      /** Safe progressive-enhancement destination until the shell resolves the action. */
      readonly href: string;
    };

export type PaletteCommandSpec = Readonly<{
  id: string;
  label: string;
  hint: string;
  group: PaletteGroup;
  icon?: string;
  scope: PaletteCommandScope;
  permission: PalettePermission;
  actionClass: ActionClass;
  executionKind: PaletteExecutionKind;
  analyticsEvent: PaletteAnalyticsEvent;
  availability: PaletteAvailability;
  target: PaletteTarget;
}>;

const GLOBAL_SCOPE = { kind: "global" } as const satisfies PaletteCommandScope;
const WORKSPACE_SCOPE = {
  kind: "workspace",
  workspace: "split-pane",
} as const satisfies PaletteCommandScope;

const AUTHENTICATED_PERMISSION = {
  authentication: "required",
  ownership: "not-applicable",
} as const satisfies PalettePermission;

const OWNER_MUTATION_PERMISSION = {
  authentication: "required",
  ownership: "server-enforced",
} as const satisfies PalettePermission;

const AVAILABLE = { kind: "available" } as const satisfies PaletteAvailability;

const SPLIT_PANE_AVAILABLE = {
  kind: "contextual",
  requires: ["workspace-shell", "active-pane", "multiple-panes"],
  unavailableReason: "Open a split workspace with more than one pane.",
} as const satisfies PaletteAvailability;

// These entries open the module's real creation surface. They intentionally do
// not use mutation semantics or claim that a record has already been created.
export const PALETTE_CREATE_COMMANDS = [
  {
    id: "create-note",
    label: "Open New Note Creator",
    hint: "Open creation surface · notes",
    group: "create",
    icon: "create",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "navigation",
    analyticsEvent: "command_palette.create_surface_opened",
    availability: AVAILABLE,
    target: { kind: "route", href: "/notes", intent: "open-create-surface" },
  },
  {
    id: "create-task",
    label: "Open New Task Creator",
    hint: "Open creation surface · agenda",
    group: "create",
    icon: "create",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "navigation",
    analyticsEvent: "command_palette.create_surface_opened",
    availability: AVAILABLE,
    target: { kind: "route", href: "/agenda", intent: "open-create-surface" },
  },
  {
    id: "create-event",
    label: "Open New Event Creator",
    hint: "Open creation surface · schedule",
    group: "create",
    icon: "create",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "navigation",
    analyticsEvent: "command_palette.create_surface_opened",
    availability: AVAILABLE,
    target: { kind: "route", href: "/schedule", intent: "open-create-surface" },
  },
  {
    id: "create-signal",
    label: "Open New Signal Capture",
    hint: "Open creation surface · dispatch",
    group: "create",
    icon: "create",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "navigation",
    analyticsEvent: "command_palette.create_surface_opened",
    availability: AVAILABLE,
    target: { kind: "route", href: "/dispatch", intent: "open-create-surface" },
  },
] as const satisfies readonly PaletteCommandSpec[];

export const PALETTE_WORKSPACE_COMMANDS = [
  {
    id: "workspace-focus-next-pane",
    label: "Focus Next Pane",
    hint: "Workspace · cycle focus",
    group: "action",
    icon: "console",
    scope: WORKSPACE_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "client-action",
    analyticsEvent: "command_palette.workspace_action_selected",
    availability: SPLIT_PANE_AVAILABLE,
    target: { kind: "workspace-action", action: "focus-next-pane", href: "/command" },
  },
  {
    id: "workspace-close-active-pane",
    label: "Close Active Pane",
    hint: "Workspace · close pane",
    group: "action",
    icon: "console",
    scope: WORKSPACE_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "client-action",
    analyticsEvent: "command_palette.workspace_action_selected",
    availability: SPLIT_PANE_AVAILABLE,
    target: { kind: "workspace-action", action: "close-active-pane", href: "/command" },
  },
  {
    id: "workspace-reset-pane-widths",
    label: "Reset Pane Widths",
    hint: "Workspace · equal widths",
    group: "action",
    icon: "console",
    scope: WORKSPACE_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "client-action",
    analyticsEvent: "command_palette.workspace_action_selected",
    availability: SPLIT_PANE_AVAILABLE,
    target: { kind: "workspace-action", action: "reset-pane-widths", href: "/command" },
  },
] as const satisfies readonly PaletteCommandSpec[];

export const PALETTE_ACTION_COMMANDS = [
  {
    id: "action-interface-studio",
    label: "Interface Studio",
    hint: "Action · theme & appearance",
    group: "action",
    icon: "palette",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "client-action",
    analyticsEvent: "command_palette.client_action_selected",
    availability: AVAILABLE,
    target: { kind: "interface-studio" },
  },
  {
    id: "action-vitality",
    label: "Open Workout Log",
    hint: "Open workflow · vitality",
    group: "action",
    icon: "fitness",
    scope: GLOBAL_SCOPE,
    permission: AUTHENTICATED_PERMISSION,
    actionClass: "READ",
    executionKind: "navigation",
    analyticsEvent: "command_palette.navigation_selected",
    availability: AVAILABLE,
    target: { kind: "route", href: "/vitality", intent: "navigate" },
  },
  {
    id: "action-concentration-check",
    label: "Run Concentration Check",
    hint: "Action · routines",
    group: "action",
    icon: "tasks",
    scope: GLOBAL_SCOPE,
    permission: OWNER_MUTATION_PERMISSION,
    // The routine persists a run and may create tasks. It never places trades.
    actionClass: "INTERNAL_WRITE",
    executionKind: "mutation",
    analyticsEvent: "command_palette.mutation_requested",
    availability: AVAILABLE,
    target: { kind: "run-routine", routine: "concentration-check", href: "/tasks" },
  },
  ...PALETTE_WORKSPACE_COMMANDS,
] as const satisfies readonly PaletteCommandSpec[];

// Full registry: create + action + exactly one navigate command per nav route.
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
      scope: GLOBAL_SCOPE,
      permission: AUTHENTICATED_PERMISSION,
      actionClass: "READ",
      executionKind: "navigation",
      analyticsEvent: "command_palette.navigation_selected",
      availability: AVAILABLE,
      target: { kind: "route", href: item.href, intent: "navigate" },
    })),
  ];
}

// Case-insensitive match over label, hint, and group — mirrors the palette's
// interactive filter.
export function filterPaletteCommandSpecs<T extends Pick<PaletteCommandSpec, "label" | "hint" | "group">>(
  specs: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...specs];
  return specs.filter(
    (command) =>
      command.label.toLowerCase().includes(q) ||
      command.hint.toLowerCase().includes(q) ||
      command.group.toLowerCase().includes(q),
  );
}
