import { describe, it, expect } from "vitest";
import {
  INTEGRATION_REGISTRY,
  getProviderDescriptor,
  listProviders,
  getCapabilities,
} from "./registry";

describe("INTEGRATION_REGISTRY", () => {
  it("contains gmail and outlook mail providers", () => {
    const providers = INTEGRATION_REGISTRY.map((p) => `${p.domain}/${p.provider}`);
    expect(providers).toContain("mail/gmail");
    expect(providers).toContain("mail/outlook");
  });

  it("every provider has at least one transport", () => {
    for (const p of INTEGRATION_REGISTRY) {
      expect(p.transports.length).toBeGreaterThan(0);
    }
  });

  it("every provider has capabilities for each declared transport", () => {
    for (const p of INTEGRATION_REGISTRY) {
      for (const t of p.transports) {
        expect(p.capabilities[t]).toBeDefined();
      }
    }
  });
});

describe("getProviderDescriptor()", () => {
  it("finds gmail by domain+provider", () => {
    const d = getProviderDescriptor("mail", "gmail");
    expect(d).toBeDefined();
    expect(d!.label).toBe("Gmail");
    expect(d!.transports).toContain("direct");
    expect(d!.transports).toContain("composio");
  });

  it("finds outlook by domain+provider", () => {
    const d = getProviderDescriptor("mail", "outlook");
    expect(d).toBeDefined();
    expect(d!.label).toBe("Outlook");
  });

  it("returns undefined for unknown provider", () => {
    expect(getProviderDescriptor("mail", "yahoo")).toBeUndefined();
  });

  it("returns undefined for wrong domain", () => {
    expect(getProviderDescriptor("calendar", "gmail")).toBeUndefined();
  });
});

describe("listProviders()", () => {
  it("returns all mail providers", () => {
    const list = listProviders("mail");
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.map((p) => p.provider)).toContain("gmail");
    expect(list.map((p) => p.provider)).toContain("outlook");
  });

  it("returns empty for domain with no providers", () => {
    expect(listProviders("calendar")).toEqual([]);
  });
});

describe("getCapabilities()", () => {
  it("returns full capabilities for gmail direct", () => {
    const cap = getCapabilities("mail", "gmail", "direct");
    expect(cap).toBeDefined();
    expect(cap!.list).toBe(true);
    expect(cap!.send).toBe(true);
    expect(cap!.markRead).toBe(true);
    expect(cap!.delete).toBe(true);
  });

  it("returns limited capabilities for gmail composio", () => {
    const cap = getCapabilities("mail", "gmail", "composio");
    expect(cap).toBeDefined();
    expect(cap!.list).toBe(true);
    expect(cap!.send).toBe(true);
    // Per-message mutations not yet supported on composio
    expect(cap!.markRead).toBe(false);
    expect(cap!.archive).toBe(false);
    expect(cap!.delete).toBe(false);
  });

  it("returns undefined for unknown provider", () => {
    expect(getCapabilities("mail", "yahoo", "direct")).toBeUndefined();
  });

  it("returns undefined for unknown transport", () => {
    // Transport not in the capabilities record
    expect(getCapabilities("mail", "gmail", "unknown-transport" as any)).toBeUndefined();
  });
});
