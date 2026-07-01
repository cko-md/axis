import { describe, expect, it } from "vitest";
import {
  WIDGET_ACTION_KIND_LABELS,
  widgetActionLabel,
} from "@/components/widgets/WidgetActionMenu";
import {
  WIDGET_STATUS_LABELS,
  widgetStatusLabel,
} from "@/components/widgets/WidgetStatusBadge";
import type { WidgetAction, WidgetStatus } from "@/lib/widgets/types";

const widgetStatuses = [
  "fresh",
  "live",
  "loading",
  "refreshing",
  "stale",
  "error",
  "empty",
  "disconnected",
  "setup_required",
  "lab",
  "disabled",
] satisfies WidgetStatus[];

const widgetActionKinds = [
  "refresh",
  "navigate",
  "open-drawer",
  "create",
  "configure",
  "hide",
] satisfies WidgetAction["kind"][];

describe("widget primitive contracts", () => {
  it("keeps every widget status mapped to a human-readable label", () => {
    expect(Object.keys(WIDGET_STATUS_LABELS).sort()).toEqual([...widgetStatuses].sort());

    for (const status of widgetStatuses) {
      expect(widgetStatusLabel(status)).toEqual(WIDGET_STATUS_LABELS[status]);
      expect(widgetStatusLabel(status)).toMatch(/\S/);
    }
  });

  it("keeps every widget action kind mapped to a fallback label", () => {
    expect(Object.keys(WIDGET_ACTION_KIND_LABELS).sort()).toEqual([...widgetActionKinds].sort());

    for (const kind of widgetActionKinds) {
      expect(WIDGET_ACTION_KIND_LABELS[kind]).toMatch(/\S/);
    }
  });

  it("prefers explicit action labels and falls back by action kind", () => {
    const explicitAction: WidgetAction = {
      id: "refresh-now",
      label: "Refresh now",
      kind: "refresh",
    };
    const fallbackAction: WidgetAction = {
      id: "open-default",
      label: "",
      kind: "open-drawer",
    };

    expect(widgetActionLabel(explicitAction)).toEqual("Refresh now");
    expect(widgetActionLabel(fallbackAction)).toEqual("Open");
  });
});
