import { describe, expect, it } from "vitest";
import {
  shouldAnimateWidgetStatus,
  shouldSpinWidgetIcon,
  WIDGET_MOTION,
  widgetMotionMode,
} from "@/components/widgets/widgetMotion";

describe("widget motion contract", () => {
  it("resolves reduced-motion preferences into explicit modes", () => {
    expect(widgetMotionMode(true)).toEqual("reduced");
    expect(widgetMotionMode(false)).toEqual("standard");
    expect(widgetMotionMode(null)).toEqual("standard");
  });

  it("only animates live status affordances in standard motion", () => {
    expect(shouldAnimateWidgetStatus("loading", "standard")).toBe(true);
    expect(shouldAnimateWidgetStatus("refreshing", "standard")).toBe(true);
    expect(shouldAnimateWidgetStatus("error", "standard")).toBe(true);
    expect(shouldAnimateWidgetStatus("fresh", "standard")).toBe(false);
    expect(shouldAnimateWidgetStatus("loading", "reduced")).toBe(false);
  });

  it("only spins widget icons for loading states in standard motion", () => {
    expect(shouldSpinWidgetIcon("loading", "standard")).toBe(true);
    expect(shouldSpinWidgetIcon("refreshing", "standard")).toBe(true);
    expect(shouldSpinWidgetIcon("error", "standard")).toBe(false);
    expect(shouldSpinWidgetIcon("loading", "reduced")).toBe(false);
  });

  it("keeps named motion timings available for shared primitives", () => {
    expect(WIDGET_MOTION.shellEntry.duration).toBeGreaterThan(0);
    expect(WIDGET_MOTION.drawerPanel.ease).toHaveLength(4);
  });
});
