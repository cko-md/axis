import { describe, expect, it } from "vitest";
import {
  formatWidgetDetailUpdatedAt,
  widgetDetailSectionTitleId,
} from "@/components/widgets/WidgetDetailDrawer";

describe("WidgetDetailDrawer", () => {
  it("formats valid update timestamps for compact drawer metadata", () => {
    expect(formatWidgetDetailUpdatedAt("2026-07-01T14:05:00Z")).toMatch(/Jul 1/);
  });

  it("ignores missing or invalid update timestamps", () => {
    expect(formatWidgetDetailUpdatedAt()).toBeNull();
    expect(formatWidgetDetailUpdatedAt("not-a-date")).toBeNull();
  });

  it("normalizes section ids before using them as DOM title ids", () => {
    expect(widgetDetailSectionTitleId(" Source Health ")).toEqual("widget-detail-section-source-health");
    expect(widgetDetailSectionTitleId("")).toEqual("widget-detail-section-section");
  });
});
