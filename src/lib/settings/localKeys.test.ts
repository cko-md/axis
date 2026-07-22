import { describe, expect, it } from "vitest";
import { isAxisLocalKey } from "@/lib/settings/localKeys";

describe("isAxisLocalKey", () => {
  it("matches dash-prefixed keys", () => {
    expect(isAxisLocalKey("axis-theme")).toBe(true);
    expect(isAxisLocalKey("axis-nav-order")).toBe(true);
    expect(isAxisLocalKey("axis-console-sections")).toBe(true);
  });

  it("matches dot-namespaced keys the old filter missed", () => {
    expect(isAxisLocalKey("axis.literature.topics")).toBe(true);
    expect(isAxisLocalKey("axis.setting.nav.customization")).toBe(true);
    expect(isAxisLocalKey("axis.fitness_routines.v1.run.uid")).toBe(true);
  });

  it("matches the two unprefixed keys the app writes", () => {
    expect(isAxisLocalKey("axiom-focus")).toBe(true);
    expect(isAxisLocalKey("debrief-reminder")).toBe(true);
  });

  it("does not match unrelated keys", () => {
    expect(isAxisLocalKey("theme")).toBe(false);
    expect(isAxisLocalKey("sb-auth-token")).toBe(false);
    expect(isAxisLocalKey("axistrophe")).toBe(false); // not axis- or axis.
    expect(isAxisLocalKey("random")).toBe(false);
  });
});
