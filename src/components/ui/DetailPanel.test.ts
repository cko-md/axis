import { describe, expect, it } from "vitest";
import { detailPanelSectionTitleId } from "@/components/ui/DetailPanel";
import { widgetDetailSectionTitleId } from "@/components/widgets/WidgetDetailDrawer";

describe("DetailPanel anatomy", () => {
  it("normalizes shared detail section title ids", () => {
    expect(detailPanelSectionTitleId(" Source Health ")).toEqual("detail-panel-section-source-health");
    expect(detailPanelSectionTitleId("")).toEqual("detail-panel-section-section");
  });

  it("allows feature-specific id prefixes for existing drawers", () => {
    expect(widgetDetailSectionTitleId(" Source Health ")).toEqual("widget-detail-section-source-health");
  });
});
