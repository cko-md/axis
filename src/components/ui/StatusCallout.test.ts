import { describe, expect, it } from "vitest";
import {
  STATUS_CALLOUT_LABELS,
  statusCalloutRole,
  type StatusCalloutKind,
} from "@/components/ui/StatusCallout";

const statusKinds = [
  "loading",
  "empty",
  "error",
  "stale",
  "disconnected",
  "setup_required",
  "success",
  "info",
] satisfies StatusCalloutKind[];

describe("StatusCallout", () => {
  it("keeps every shared status kind mapped to a visible label", () => {
    expect(Object.keys(STATUS_CALLOUT_LABELS).sort()).toEqual([...statusKinds].sort());

    for (const kind of statusKinds) {
      expect(STATUS_CALLOUT_LABELS[kind]).toMatch(/\S/);
    }
  });

  it("reserves alert semantics for error states", () => {
    expect(statusCalloutRole("error")).toEqual("alert");
    expect(statusCalloutRole("stale")).toEqual("status");
    expect(statusCalloutRole("loading")).toEqual("status");
  });
});
