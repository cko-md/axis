import { describe, expect, it } from "vitest";
import { widgetLegacyStatusLabel, widgetRuntimeStatus } from "@/components/console/widget-grid-model";

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
});
