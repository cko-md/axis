import { describe, expect, it } from "vitest";
import { mailAccountQuery } from "@/lib/mail/query";

describe("mailAccountQuery", () => {
  it("builds provider + email query without accountId", () => {
    expect(
      mailAccountQuery({ provider: "gmail", accountEmail: "user@gmail.com" }),
    ).toBe("provider=gmail&email=user%40gmail.com");
  });

  it("includes accountId for Composio multi-account disambiguation", () => {
    expect(
      mailAccountQuery({
        provider: "gmail",
        accountEmail: "user@gmail.com",
        connectionId: "axis-connection-123",
      }),
    ).toBe("provider=gmail&email=user%40gmail.com&accountId=axis-connection-123");
  });
});
