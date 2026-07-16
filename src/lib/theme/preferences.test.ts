import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INTERFACE_SETTINGS } from "@/lib/theme/interface-settings";
import {
  buildPreferenceEnvelope,
  createSerialExecutor,
  fieldWasEditedSince,
  parsePreferenceEnvelope,
} from "@/lib/theme/preferences";

describe("preference envelope", () => {
  it("does not mistake metadata-only envelopes for interface settings", () => {
    const parsed = parsePreferenceEnvelope({
      timeZone: "America/New_York",
      futureField: { enabled: true },
    });
    expect(parsed.theme).toBeUndefined();
    expect(parsed.settings).toBeUndefined();
    expect(parsed.envelope.futureField).toEqual({ enabled: true });
  });

  it("supports nested and legacy settings while deep-merging notification flags", () => {
    expect(parsePreferenceEnvelope({
      theme: "dim",
      settings: { accent: "marine", notifFeatures: { mail: true } },
    })).toMatchObject({
      theme: "dim",
      settings: {
        accent: "marine",
        notifFeatures: {
          mail: true,
          agenda: DEFAULT_INTERFACE_SETTINGS.notifFeatures.agenda,
        },
      },
    });
    expect(parsePreferenceEnvelope({ accent: "sage" }).settings?.accent).toBe("sage");
  });

  it("preserves unknown metadata and an existing timezone when no new timezone is available", () => {
    const base = {
      timeZone: "Europe/London",
      futureField: { version: 2 },
    };
    expect(
      buildPreferenceEnvelope(base, "light", DEFAULT_INTERFACE_SETTINGS, undefined),
    ).toMatchObject({
      theme: "light",
      timeZone: "Europe/London",
      futureField: { version: 2 },
    });
  });

  it("detects user edits made while remote hydration is in flight", () => {
    expect(fieldWasEditedSince(3, 3)).toBe(false);
    expect(fieldWasEditedSince(3, 4)).toBe(true);
  });

  it("serializes writes so a newer edit cannot finish before an older write", async () => {
    const executor = createSerialExecutor();
    let releaseFirst!: () => void;
    const order: string[] = [];
    const first = executor.enqueue(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      return "first";
    });
    const secondTask = vi.fn(async () => {
      order.push("second");
      return "second";
    });
    const second = executor.enqueue(secondTask);

    await Promise.resolve();
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
