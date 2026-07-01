import { describe, expect, it } from "vitest";
import {
  nextEnabledActionIndex,
} from "@/components/widgets/WidgetActionMenu";
import {
  widgetShellAriaLabel,
} from "@/components/widgets/WidgetShell";
import type { WidgetAction } from "@/lib/widgets/types";

const actions: WidgetAction[] = [
  { id: "refresh", label: "Refresh", kind: "refresh" },
  { id: "configure", label: "Configure", kind: "configure", disabledReason: "Not ready" },
  { id: "open", label: "Open", kind: "open-drawer" },
];

describe("widget accessibility helpers", () => {
  it("builds stable shell labels for string and custom values", () => {
    expect(widgetShellAriaLabel("Weather", "72 degrees")).toEqual("Weather: 72 degrees");
    expect(widgetShellAriaLabel("Weather", 72)).toEqual("Weather: open details");
  });

  it("moves menu focus across enabled actions only", () => {
    expect(nextEnabledActionIndex(actions, -1, 1)).toEqual(0);
    expect(nextEnabledActionIndex(actions, 0, 1)).toEqual(2);
    expect(nextEnabledActionIndex(actions, 2, 1)).toEqual(0);
    expect(nextEnabledActionIndex(actions, 0, -1)).toEqual(2);
  });

  it("returns -1 when every action is disabled", () => {
    expect(nextEnabledActionIndex(actions.map((action) => ({ ...action, disabledReason: "Disabled" })), -1, 1)).toEqual(-1);
  });
});
