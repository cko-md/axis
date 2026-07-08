import { describe, expect, it } from "vitest";
import { findMailAccount } from "./findAccount";
import type { MailAccountRef } from "./tokens";

describe("findMailAccount", () => {
  const accounts: MailAccountRef[] = [
    { provider: "gmail", mailEmail: "user@gmail.com" },
    {
      provider: "gmail",
      mailEmail: "Connected account",
      via: "composio",
      connectedAccountId: "ca_123",
    },
  ];

  it("matches by connected account id first", () => {
    expect(findMailAccount(accounts, "gmail", "wrong@example.com", "ca_123")?.via).toBe("composio");
  });

  it("falls back to the sole composio account for placeholder email", () => {
    expect(findMailAccount(accounts, "gmail", "Connected account")?.connectedAccountId).toBe("ca_123");
  });
});
