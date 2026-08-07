import { describe, expect, it } from "vitest";
import { DEFAULT_INTERFACE_SETTINGS } from "./interface-settings";
import { parsePreferenceEnvelopeStrict } from "./preferences";

describe("parsePreferenceEnvelopeStrict", () => {
  it("accepts empty, legacy partial, and metadata-preserving envelopes", () => {
    expect(parsePreferenceEnvelopeStrict({})).toEqual({ envelope: {} });
    expect(parsePreferenceEnvelopeStrict({
      accent: "sage",
      notifEnabled: true,
      metadata: { revision: 2 },
    })).toEqual(expect.objectContaining({
      envelope: expect.objectContaining({ metadata: { revision: 2 } }),
      settings: expect.objectContaining({
        ...DEFAULT_INTERFACE_SETTINGS,
        accent: "sage",
        notifEnabled: true,
      }),
    }));
  });

  it("accepts a valid partial nested settings envelope", () => {
    expect(parsePreferenceEnvelopeStrict({
      theme: "slate",
      settings: {
        surfaceTone: "deep",
        cornerRadius: 16,
        notifFeatures: { mail: true },
      },
      preserved: true,
    })).toEqual(expect.objectContaining({
      theme: "slate",
      settings: expect.objectContaining({
        surfaceTone: "deep",
        cornerRadius: 16,
        notifFeatures: expect.objectContaining({ mail: true }),
      }),
    }));
  });

  it.each(["iris", "arctic", "sapphire", "emerald", "platinum", "neon"])(
    "normalizes documented stale accent %s in nested and legacy envelopes",
    (accent) => {
      expect(parsePreferenceEnvelopeStrict({ settings: { accent } }))
        .toEqual(expect.objectContaining({
          settings: expect.objectContaining({ accent: "gold" }),
        }));
      expect(parsePreferenceEnvelopeStrict({ accent }))
        .toEqual(expect.objectContaining({
          settings: expect.objectContaining({ accent: "gold" }),
        }));
    },
  );

  it.each([
    { theme: "red" },
    { settings: null },
    { settings: { accent: "unknown-accent" } },
    { settings: { cornerRadius: 16.5 } },
    { settings: { cornerRadius: 17 } },
    { settings: { notifEnabled: "yes" } },
    { settings: { unknown: true } },
    { settings: { notifFeatures: { unknown: true } } },
  ])("rejects malformed known preference fields: %j", (envelope) => {
    expect(parsePreferenceEnvelopeStrict(envelope)).toBeNull();
  });
});
