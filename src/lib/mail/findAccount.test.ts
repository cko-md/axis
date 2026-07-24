import { describe, expect, it } from "vitest";
import { findMailAccount } from "./findAccount";
import type { MailAccountRef } from "./tokens";

describe("findMailAccount", () => {
  const accounts: MailAccountRef[] = [
    { provider: "gmail", mailEmail: "user@gmail.com", via: "composio", connectionId: "axis-connection-456" },
    {
      provider: "gmail",
      mailEmail: "Connected account",
      via: "composio",
      connectionId: "axis-connection-123",
    },
  ];

  it("matches only by local connection id and provider/email binding", () => {
    expect(findMailAccount(accounts, "gmail", "Connected account", "axis-connection-123")?.via).toBe("composio");
  });

  it("never accepts a display label as a mailbox selector", () => {
    expect(findMailAccount(accounts, "gmail", "Connected account")).toBeUndefined();
  });
});
