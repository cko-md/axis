import { describe, expect, it } from "vitest";
import {
  capabilitiesRiskProfile,
  capabilityActionClass,
  providerRiskProfile,
} from "./risk";
import { getProviderDescriptor } from "./registry";
import type { ProviderCapabilities } from "./registry";

const readOnly: ProviderCapabilities = {
  list: true, read: true, attachmentDownload: true,
  send: false, reply: false, markRead: false, archive: false, delete: false,
};

const full: ProviderCapabilities = {
  list: true, read: true, send: true, reply: true,
  markRead: true, archive: true, delete: true, attachmentDownload: true,
};

describe("integration risk model", () => {
  it("maps capabilities to action classes", () => {
    expect(capabilityActionClass("read")).toBe("READ");
    expect(capabilityActionClass("archive")).toBe("INTERNAL_WRITE");
    expect(capabilityActionClass("send")).toBe("EXTERNAL_COMMUNICATION");
    expect(capabilityActionClass("delete")).toBe("DESTRUCTIVE_ADMIN");
  });

  it("classifies a read-only provider as read_only with auto approval", () => {
    const p = capabilitiesRiskProfile(readOnly);
    expect(p.riskLevel).toBe("read_only");
    expect(p.highestClass).toBe("READ");
    expect(p.approvalDefault).toBe("auto");
    expect(p.sendCaps).toEqual([]);
    expect(p.destructiveCaps).toEqual([]);
    expect(p.enabledCount).toBe(3);
  });

  it("classifies a full provider as destructive with step-up approval", () => {
    const p = capabilitiesRiskProfile(full);
    expect(p.highestClass).toBe("DESTRUCTIVE_ADMIN");
    expect(p.riskLevel).toBe("destructive");
    expect(p.approvalDefault).toBe("approval_step_up");
    expect(p.destructiveCaps).toContain("delete");
    expect(p.sendCaps).toEqual(expect.arrayContaining(["send", "reply"]));
  });

  it("disabled capabilities never contribute risk", () => {
    const noDelete: ProviderCapabilities = { ...full, delete: false };
    const p = capabilitiesRiskProfile(noDelete);
    expect(p.destructiveCaps).toEqual([]);
    expect(p.highestClass).toBe("EXTERNAL_COMMUNICATION");
    expect(p.riskLevel).toBe("sends");
  });

  it("derives a profile from the real registry (gmail/direct sends)", () => {
    const gmail = getProviderDescriptor("mail", "gmail");
    expect(gmail).toBeDefined();
    const profile = providerRiskProfile(gmail!, "direct");
    expect(profile?.riskLevel).toBe("destructive"); // direct gmail has delete
    expect(profile?.approvalDefault).toBe("approval_step_up");
  });
});
