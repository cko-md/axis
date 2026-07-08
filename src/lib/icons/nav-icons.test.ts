import { describe, expect, it } from "vitest";
import { NAV_ICON_MAP, resolveNavIcon } from "@/lib/icons/nav-icons";
import { LineChart } from "lucide-react";

describe("nav-icons", () => {
  it("maps all DEFAULT_NAV icon keys", async () => {
    const { DEFAULT_NAV } = await import("@/lib/store/nav");
    const keys = new Set(DEFAULT_NAV.flatMap((g) => g.items.map((i) => i.icon)));
    for (const key of keys) {
      expect(NAV_ICON_MAP[key], `missing icon for ${key}`).toBeDefined();
    }
  });

  it("falls back to LineChart for unknown keys", () => {
    expect(resolveNavIcon("unknown-key")).toBe(LineChart);
  });
});
