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

  it("does not resolve a connected account id across providers", () => {
    const mixed = [...accounts, {
      provider: "outlook" as const,
      mailEmail: "Connected account",
      via: "composio" as const,
      connectedAccountId: "ca_outlook",
    }];
    expect(findMailAccount(mixed, "gmail", "wrong@example.com", "ca_outlook")).toBeUndefined();
  });
});
