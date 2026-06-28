import { describe, it, expect } from "vitest";
import {
  resolveMailAdapter,
  adapterForAccount,
  mailErrorStatus,
} from "./index";
import type { MailAccountRef } from "../tokens";

describe("resolveMailAdapter()", () => {
  it("returns a gmail direct adapter", () => {
    const adapter = resolveMailAdapter("gmail", "direct");
    expect(adapter.provider).toBe("gmail");
    expect(adapter.transport).toBe("direct");
  });

  it("returns a gmail composio adapter", () => {
    const adapter = resolveMailAdapter("gmail", "composio");
    expect(adapter.provider).toBe("gmail");
    expect(adapter.transport).toBe("composio");
  });

  it("returns an outlook direct adapter", () => {
    const adapter = resolveMailAdapter("outlook", "direct");
    expect(adapter.provider).toBe("outlook");
    expect(adapter.transport).toBe("direct");
  });

  it("returns an outlook composio adapter", () => {
    const adapter = resolveMailAdapter("outlook", "composio");
    expect(adapter.provider).toBe("outlook");
    expect(adapter.transport).toBe("composio");
  });
});

describe("adapterForAccount()", () => {
  it("resolves composio account to composio transport", () => {
    const account: MailAccountRef = {
      provider: "gmail",
      mailEmail: "user@gmail.com",
      via: "composio",
      connectedAccountId: "abc123",
    };
    const adapter = adapterForAccount(account);
    expect(adapter.transport).toBe("composio");
    expect(adapter.provider).toBe("gmail");
  });

  it("resolves direct (non-composio) account to direct transport", () => {
    const account: MailAccountRef = {
      provider: "outlook",
      mailEmail: "user@outlook.com",
    };
    const adapter = adapterForAccount(account);
    expect(adapter.transport).toBe("direct");
    expect(adapter.provider).toBe("outlook");
  });
});

describe("mailErrorStatus()", () => {
  it("maps auth_expired → 401", () => {
    expect(mailErrorStatus("auth_expired")).toBe(401);
  });

  it("maps invalid_request → 400", () => {
    expect(mailErrorStatus("invalid_request")).toBe(400);
  });

  it("maps not_found → 404", () => {
    expect(mailErrorStatus("not_found")).toBe(404);
  });

  it("maps rate_limited → 429", () => {
    expect(mailErrorStatus("rate_limited")).toBe(429);
  });

  it("maps not_supported → 501", () => {
    expect(mailErrorStatus("not_supported")).toBe(501);
  });

  it("maps provider_error → 502", () => {
    expect(mailErrorStatus("provider_error")).toBe(502);
  });

  it("maps network → 502", () => {
    expect(mailErrorStatus("network")).toBe(502);
  });

  it("maps unknown → 502", () => {
    expect(mailErrorStatus("unknown")).toBe(502);
  });
});
