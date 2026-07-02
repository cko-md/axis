import { describe, expect, it } from "vitest";
import {
  CONSOLE_SECTION_DRILL_INS,
  resolveWidgetTileActivation,
  taskRingProgress,
  widgetLegacyStatusLabel,
  widgetRuntimeStatus,
} from "@/components/console/widget-grid-model";
import { WIDGET_REGISTRY } from "@/lib/widgets/registry";

describe("WidgetGrid model", () => {
  it("prioritizes runtime loading/error/stale states over defaults", () => {
    expect(widgetRuntimeStatus("weather", { loading: true })).toEqual("loading");
    expect(widgetRuntimeStatus("weather", { loading: true, updatedAt: "2026-07-01T12:00:00Z" })).toEqual("refreshing");
    expect(widgetRuntimeStatus("weather", { error: true })).toEqual("error");
    expect(widgetRuntimeStatus("weather", { error: true, stale: true })).toEqual("stale");
    expect(widgetRuntimeStatus("weather", { stale: true })).toEqual("stale");
    expect(widgetRuntimeStatus("weather", { updatedAt: "2026-07-01T12:00:00Z" })).toEqual("fresh");
  });

  it("falls back to registry defaults or catalog lab/setup states", () => {
    expect(widgetRuntimeStatus("sleep", undefined)).toEqual("lab");
    expect(widgetRuntimeStatus("unknown", undefined, false)).toEqual("lab");
    expect(widgetRuntimeStatus("unknown", undefined, true)).toEqual("setup_required");
  });

  it("keeps legacy non-shell widget labels stable", () => {
    expect(widgetLegacyStatusLabel("fresh")).toEqual("Fresh");
    expect(widgetLegacyStatusLabel("refreshing")).toEqual("Refreshing");
    expect(widgetLegacyStatusLabel("setup_required")).toEqual("Setup");
  });

  it("uses actual task counts for the task progress ring", () => {
    expect(taskRingProgress([])).toMatchObject({
      done: 0,
      total: 0,
      label: "No tasks",
      strokeDashoffset: 176,
    });

    expect(taskRingProgress([{ status: "done" }, { status: "open" }])).toMatchObject({
      done: 1,
      total: 2,
      label: "1 / 2",
      strokeDashoffset: 88,
    });
  });

  it("declares routes for data-backed Console drill-in sections", () => {
    expect(CONSOLE_SECTION_DRILL_INS["dispatch-block"]).toEqual({ href: "/dispatch", label: "Open Dispatch" });
    expect(CONSOLE_SECTION_DRILL_INS["todays-arc"]).toEqual({ href: "/schedule", label: "Open Schedule" });
    expect(CONSOLE_SECTION_DRILL_INS["focus-ranked"]).toEqual({ href: "/agenda", label: "Open Agenda" });
    expect(CONSOLE_SECTION_DRILL_INS["people-spotlight"]).toEqual({ href: "/people", label: "Open People" });
    expect(CONSOLE_SECTION_DRILL_INS["markets-body"]).toEqual({ href: "/fund/market", label: "Open Markets" });
  });

  it("resolves navigate and open-drawer activations", () => {
    expect(resolveWidgetTileActivation("agenda")).toEqual({ kind: "navigate", href: "/agenda", label: "Open Agenda" });
    expect(resolveWidgetTileActivation("markets")).toEqual({ kind: "navigate", href: "/fund/market", label: "Open markets" });
    expect(resolveWidgetTileActivation("sleep")).toEqual({ kind: "navigate", href: "/vitality", label: "Open Vitality" });
    expect(resolveWidgetTileActivation("weather")).toEqual({ kind: "open-drawer", label: "Open weather details" });
    expect(resolveWidgetTileActivation("location")).toEqual({ kind: "open-drawer", label: "Open location details" });
    expect(resolveWidgetTileActivation("unknown-widget")).toBeNull();
  });

  // DISP-2: no dead tiles. Every shipped widget must click through to a real
  // destination — either navigate to a module route or open a detail drawer.
  it("guarantees no dead tiles across the registry", () => {
    for (const widget of WIDGET_REGISTRY) {
      const activation = resolveWidgetTileActivation(widget.id);
      expect(activation, `${widget.id} is a dead tile (no navigate/drawer activation)`).not.toBeNull();
      if (activation?.kind === "navigate") {
        expect(activation.href, `${widget.id} navigates to an empty href`).toMatch(/^\//);
      }
    }
  });
});
