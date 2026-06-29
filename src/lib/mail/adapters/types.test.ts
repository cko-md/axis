import { describe, it, expect } from "vitest";
import { toMailContext } from "./types";
import type { MailAccountRef } from "../tokens";

describe("toMailContext()", () => {
  it("maps a direct Gmail account ref", () => {
    const ref: MailAccountRef = {
      provider: "gmail",
      mailEmail: "user@gmail.com",
    };
    const ctx = toMailContext("uid1", ref);
    expect(ctx).toEqual({
      userId: "uid1",
      provider: "gmail",
      mailEmail: "user@gmail.com",
      transport: "direct",
      connectedAccountId: undefined,
    });
  });

  it("maps a Composio Outlook account ref", () => {
    const ref: MailAccountRef = {
      provider: "outlook",
      mailEmail: "user@outlook.com",
      via: "composio",
      connectedAccountId: "ca_123",
    };
    const ctx = toMailContext("uid2", ref);
    expect(ctx).toEqual({
      userId: "uid2",
      provider: "outlook",
      mailEmail: "user@outlook.com",
      transport: "composio",
      connectedAccountId: "ca_123",
    });
  });

  it("treats non-composio via as direct transport", () => {
    const ref: MailAccountRef = {
      provider: "gmail",
      mailEmail: "user@gmail.com",
      // no via field → direct
    };
    const ctx = toMailContext("uid3", ref);
    expect(ctx.transport).toBe("direct");
    expect(ctx.connectedAccountId).toBeUndefined();
  });
});
