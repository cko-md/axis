import { describe, expect, it } from "vitest";
import {
  buildPaletteCommandSpecs,
  filterPaletteCommandSpecs,
  PALETTE_CREATE_COMMANDS,
} from "@/components/nav/command-palette-model";
import { ALL_NAV_ITEMS } from "@/lib/store/nav";

describe("command palette model", () => {
  const specs = buildPaletteCommandSpecs();

  it("exposes a navigate command for every nav route (full ⌘K coverage)", () => {
    const navHrefs = specs
      .filter((c) => c.group === "navigate" && c.target.kind === "route")
      .map((c) => (c.target.kind === "route" ? c.target.href : ""));
    for (const item of ALL_NAV_ITEMS) {
      expect(navHrefs, `${item.href} is not reachable from the command palette`).toContain(item.href);
    }
  });

  it("exposes the core create actions (note / task / signal)", () => {
    const createHrefs = PALETTE_CREATE_COMMANDS.map((c) => (c.target.kind === "route" ? c.target.href : ""));
    expect(createHrefs).toContain("/notes");
    expect(createHrefs).toContain("/agenda"); // New Task
    expect(createHrefs).toContain("/dispatch"); // New Signal
  });

  it("has no duplicate command ids and no empty route targets (no dead commands)", () => {
    const ids = specs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of specs) {
      if (c.target.kind === "route") {
        expect(c.target.href, `${c.id} has an empty route`).toMatch(/^\//);
      }
    }
  });

  it("assigns nav icon keys to every navigate command", () => {
    const navCommands = specs.filter((c) => c.group === "navigate");
    for (const cmd of navCommands) {
      expect(cmd.icon, `${cmd.id} missing palette icon`).toBeTruthy();
    }
  });

  it("filters case-insensitively across label, hint, and group", () => {
    expect(filterPaletteCommandSpecs(specs, "").length).toBe(specs.length);
    expect(filterPaletteCommandSpecs(specs, "new task").some((c) => c.id === "create-task")).toBe(true);
    expect(filterPaletteCommandSpecs(specs, "CREATE").every((c) => c.group === "create")).toBe(true);
    expect(filterPaletteCommandSpecs(specs, "zzzznomatch")).toEqual([]);
  });

  it("exposes an executable run-routine command for the concentration check", () => {
    const cmd = specs.find((c) => c.id === "action-concentration-check");
    expect(cmd).toBeDefined();
    expect(cmd!.group).toBe("action");
    expect(cmd!.target).toEqual({ kind: "run-routine", routine: "concentration-check", href: "/tasks" });
    expect(filterPaletteCommandSpecs(specs, "concentration").some((c) => c.id === "action-concentration-check")).toBe(true);
  });

  it("covers the new Operate routes (tasks, approvals) with navigate commands", () => {
    const hrefs = specs.filter((c) => c.target.kind === "route").map((c) => (c.target as { href: string }).href);
    expect(hrefs).toEqual(expect.arrayContaining(["/tasks", "/approvals"]));
  });
});
