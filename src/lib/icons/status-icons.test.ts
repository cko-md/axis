import { describe, expect, it } from "vitest";
import { statusIconForCallout, statusIconForWidget } from "@/lib/icons/status-icons";
import type { StatusCalloutKind } from "@/components/ui/StatusCallout";
import type { WidgetStatus } from "@/lib/widgets/types";

const calloutKinds: StatusCalloutKind[] = [
  "loading", "empty", "error", "stale", "disconnected", "setup_required", "success", "info",
];

const widgetStatuses: WidgetStatus[] = [
  "fresh", "live", "loading", "refreshing", "stale", "error", "empty",
  "disconnected", "setup_required", "lab", "disabled",
];

describe("status-icons", () => {
  it("maps every StatusCalloutKind", () => {
    for (const kind of calloutKinds) {
      expect(statusIconForCallout(kind)).toBeDefined();
    }
  });

  it("maps every WidgetStatus", () => {
    for (const status of widgetStatuses) {
      expect(statusIconForWidget(status)).toBeDefined();
    }
  });
});
