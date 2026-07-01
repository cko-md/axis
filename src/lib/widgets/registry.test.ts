import { describe, expect, it } from "vitest";
import { WIDGET_CATALOG } from "@/lib/store/widgets";
import { WIDGET_REGISTRY, getWidgetDefinition, requireWidgetDefinition } from "@/lib/widgets/registry";

describe("widget registry", () => {
  it("has unique canonical widget ids and cache keys", () => {
    const ids = WIDGET_REGISTRY.map((widget) => widget.id);
    const cacheKeys = WIDGET_REGISTRY.map((widget) => widget.source.cacheKey);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(cacheKeys).size).toBe(cacheKeys.length);
  });

  it("covers every legacy catalog widget id", () => {
    const registryIds = new Set(WIDGET_REGISTRY.map((widget) => widget.id));

    for (const catalogWidget of WIDGET_CATALOG) {
      expect(registryIds.has(catalogWidget.id), `${catalogWidget.id} is missing from WIDGET_REGISTRY`).toBe(true);
    }
  });

  it("keeps registry ids present in the catalog until Console fully migrates", () => {
    const catalogIds = new Set(WIDGET_CATALOG.map((widget) => widget.id));

    for (const registryWidget of WIDGET_REGISTRY) {
      expect(catalogIds.has(registryWidget.id), `${registryWidget.id} is missing from WIDGET_CATALOG`).toBe(true);
    }
  });

  it("defines the metadata needed by WidgetShell-based rendering", () => {
    for (const widget of WIDGET_REGISTRY) {
      expect(widget.label).toBeTruthy();
      expect(widget.category).toBeTruthy();
      expect(widget.ownerModule).toBeTruthy();
      expect(widget.source.provider).toBeTruthy();
      expect(widget.source.cacheKey).toBeTruthy();
      expect(widget.freshness.refreshPolicy).toBeTruthy();
      expect(widget.freshness.staleAfterSeconds).toBeGreaterThanOrEqual(0);
      expect(widget.primaryAction.id).toBeTruthy();
      expect(widget.primaryAction.label).toBeTruthy();
      expect(widget.primaryAction.kind).toBeTruthy();
      expect(widget.detail.type).toMatch(/^(drawer|route|none)$/);
      expect(widget.renderModes.length).toBeGreaterThan(0);
      expect(widget.sentryArea).toMatch(/^widgets\./);
    }
  });

  it("resolves definitions consistently", () => {
    expect(getWidgetDefinition("weather")?.label).toBe("Weather");
    expect(requireWidgetDefinition("weather").source.endpoint).toBe("/api/widgets/weather");
    expect(() => requireWidgetDefinition("missing-widget")).toThrow("Unknown widget id");
  });
});
