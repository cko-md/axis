import { describe, expect, it } from "vitest";
import {
  buildPaletteCommandSpecs,
  filterPaletteCommandSpecs,
  PALETTE_CREATE_COMMANDS,
  PALETTE_WORKSPACE_COMMANDS,
  type PaletteAnalyticsEvent,
  type PaletteCommandSpec,
  type PaletteWorkspaceAction,
} from "@/components/nav/command-palette-model";
import type { ActionClass } from "@/lib/security/actionPolicy";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";

describe("command palette registry", () => {
  const specs = buildPaletteCommandSpecs();

  it("exposes exactly one navigate command for every nav route", () => {
    const navigateCommands = specs.filter(
      (command) => command.group === "navigate" && command.target.kind === "route",
    );
    const navHrefs = navigateCommands.map((command) =>
      command.target.kind === "route" ? command.target.href : "",
    );

    expect(navigateCommands).toHaveLength(ALL_NAV_ITEMS.length);
    expect(new Set(navHrefs).size).toBe(ALL_NAV_ITEMS.length);
    for (const item of ALL_NAV_ITEMS) {
      expect(navHrefs, `${item.href} is not reachable from the command palette`).toContain(item.href);
    }
  });

  it("opens each core creation surface without pretending the mutation already happened", () => {
    const expected = new Map([
      ["create-note", "/notes"],
      ["create-task", "/agenda"],
      ["create-event", "/schedule"],
      ["create-signal", "/dispatch"],
    ]);

    expect(PALETTE_CREATE_COMMANDS).toHaveLength(expected.size);
    for (const command of PALETTE_CREATE_COMMANDS) {
      expect(command.label).toMatch(/^Open /);
      expect(command.executionKind).toBe("navigation");
      expect(command.actionClass).toBe("READ");
      expect(command.analyticsEvent).toBe("command_palette.create_surface_opened");
      expect(command.target).toMatchObject({
        kind: "route",
        href: expected.get(command.id),
        intent: "open-create-surface",
      });
    }
  });

  it("registers every typed split-pane workspace action", () => {
    const expectedActions = new Set<PaletteWorkspaceAction>([
      "focus-next-pane",
      "close-active-pane",
      "reset-pane-widths",
    ]);

    expect(PALETTE_WORKSPACE_COMMANDS).toHaveLength(expectedActions.size);
    for (const command of PALETTE_WORKSPACE_COMMANDS) {
      expect(command.scope).toEqual({ kind: "workspace", workspace: "split-pane" });
      expect(command.executionKind).toBe("client-action");
      expect(command.actionClass).toBe("READ");
      expect(command.analyticsEvent).toBe("command_palette.workspace_action_selected");
      expect(command.availability).toEqual({
        kind: "contextual",
        requires: ["workspace-shell", "active-pane", "multiple-panes"],
        unavailableReason: "Open a split workspace with more than one pane.",
      });
      expect(command.target.kind).toBe("workspace-action");
      if (command.target.kind === "workspace-action") {
        expect(expectedActions.delete(command.target.action)).toBe(true);
      }
    }
    expect(expectedActions.size).toBe(0);
  });

  it("has unique ids, non-empty targets, and complete policy metadata", () => {
    const ids = specs.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);

    const actionClasses = new Set<ActionClass>([
      "READ",
      "DRAFT",
      "SIMULATE",
      "INTERNAL_WRITE",
      "EXTERNAL_COMMUNICATION",
      "FINANCIAL_EXECUTION",
      "DESTRUCTIVE_ADMIN",
    ]);
    const analyticsEvents = new Set<PaletteAnalyticsEvent>([
      "command_palette.navigation_selected",
      "command_palette.create_surface_opened",
      "command_palette.client_action_selected",
      "command_palette.workspace_action_selected",
      "command_palette.mutation_requested",
    ]);

    for (const command of specs) {
      expect(command.id.trim(), "command id must not be empty").not.toBe("");
      expect(command.label.trim(), `${command.id} label must not be empty`).not.toBe("");
      expect(command.hint.trim(), `${command.id} hint must not be empty`).not.toBe("");
      expect(command.permission.authentication).toBe("required");
      expect(actionClasses.has(command.actionClass), `${command.id} has an unknown action class`).toBe(true);
      expect(analyticsEvents.has(command.analyticsEvent), `${command.id} has no analytics event`).toBe(true);
      expect(["available", "contextual"]).toContain(command.availability.kind);

      if ("href" in command.target) {
        expect(command.target.href, `${command.id} has an empty route fallback`).toMatch(/^\//);
      }
      if (command.availability.kind === "contextual") {
        expect(command.availability.requires.length).toBeGreaterThan(0);
        expect(command.availability.unavailableReason.trim()).not.toBe("");
      }
    }
  });

  it("keeps navigation, client actions, and durable mutations policy-aligned", () => {
    for (const command of specs) {
      if (command.target.kind === "route") {
        expect(command.executionKind, command.id).toBe("navigation");
        expect(command.actionClass, command.id).toBe("READ");
        expect(command.permission.ownership, command.id).toBe("not-applicable");
      } else if (
        command.target.kind === "interface-studio" ||
        command.target.kind === "workspace-action"
      ) {
        expect(command.executionKind, command.id).toBe("client-action");
        expect(command.actionClass, command.id).toBe("READ");
        expect(command.permission.ownership, command.id).toBe("not-applicable");
      } else {
        expect(command.target.kind).toBe("run-routine");
        expect(command.executionKind, command.id).toBe("mutation");
        expect(command.actionClass, command.id).toBe("INTERNAL_WRITE");
        expect(command.permission.ownership, command.id).toBe("server-enforced");
      }
    }

    expect(specs.filter((command) => command.executionKind === "mutation")).toEqual([
      expect.objectContaining({ id: "action-concentration-check" }),
    ]);
    expect(
      specs.some((command) =>
        (["FINANCIAL_EXECUTION", "DESTRUCTIVE_ADMIN"] as ActionClass[]).includes(
          command.actionClass,
        ),
      ),
    ).toBe(false);
  });

  it("assigns nav icon keys to every navigate command", () => {
    const navCommands = specs.filter((command) => command.group === "navigate");
    for (const command of navCommands) {
      expect(command.icon, `${command.id} missing palette icon`).toBeTruthy();
    }
  });

  it("filters case-insensitively across label, hint, and group", () => {
    expect(filterPaletteCommandSpecs(specs, "")).toHaveLength(specs.length);
    expect(
      filterPaletteCommandSpecs(specs, "new task").some((command) => command.id === "create-task"),
    ).toBe(true);
    expect(filterPaletteCommandSpecs(specs, "CREATE").every((command) => command.group === "create")).toBe(true);
    expect(filterPaletteCommandSpecs(specs, "zzzznomatch")).toEqual([]);
  });

  it("classifies the concentration routine as an owner-checked internal write", () => {
    const command = specs.find((candidate) => candidate.id === "action-concentration-check");
    expect(command).toMatchObject<Partial<PaletteCommandSpec>>({
      group: "action",
      actionClass: "INTERNAL_WRITE",
      executionKind: "mutation",
      analyticsEvent: "command_palette.mutation_requested",
      permission: { authentication: "required", ownership: "server-enforced" },
      target: { kind: "run-routine", routine: "concentration-check", href: "/tasks" },
    });
    expect(
      filterPaletteCommandSpecs(specs, "concentration").some(
        (candidate) => candidate.id === "action-concentration-check",
      ),
    ).toBe(true);
  });

  it("covers the Operate task and approval routes with read-only navigate commands", () => {
    for (const href of ["/tasks", "/approvals"]) {
      expect(specs).toContainEqual(
        expect.objectContaining({
          id: href,
          actionClass: "READ",
          executionKind: "navigation",
          target: { kind: "route", href, intent: "navigate" },
        }),
      );
    }
  });

  it("exposes VECTOR as a Labs navigation command", () => {
    const vector = specs.find((command) =>
      command.target.kind === "route" && command.target.href === "/vector",
    );
    expect(vector).toMatchObject({
      group: "navigate",
      icon: "vector",
      label: "VECTOR",
      hint: "Navigate · Labs",
    });
  });
});
