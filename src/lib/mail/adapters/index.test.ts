import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveMailAdapter,
  adapterForAccount,
  mailErrorStatus,
} from "./index";
import type { MailAccountRef } from "../tokens";

const mocks = vi.hoisted(() => ({
  markComposioGmailReadState: vi.fn(),
  archiveComposioGmailMessage: vi.fn(),
  trashComposioGmailMessage: vi.fn(),
}));

vi.mock("../composio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composio")>();
  return {
    ...actual,
    markComposioGmailReadState: mocks.markComposioGmailReadState,
    archiveComposioGmailMessage: mocks.archiveComposioGmailMessage,
    trashComposioGmailMessage: mocks.trashComposioGmailMessage,
  };
});

// Mail is Composio-only after the direct-adapter removal — resolveMailAdapter
// takes just a provider and always returns that provider's Composio adapter.
describe("resolveMailAdapter()", () => {
  it("returns a gmail composio adapter", () => {
    const adapter = resolveMailAdapter("gmail");
    expect(adapter.provider).toBe("gmail");
    expect(adapter.transport).toBe("composio");
  });

  it("returns an outlook composio adapter", () => {
    const adapter = resolveMailAdapter("outlook");
    expect(adapter.provider).toBe("outlook");
    expect(adapter.transport).toBe("composio");
  });
});

describe("adapterForAccount()", () => {
  it("resolves a composio account to the composio adapter", () => {
    const account: MailAccountRef = {
      provider: "gmail",
      mailEmail: "user@gmail.com",
      via: "composio",
      connectionId: "axis-connection-123",
    };
    const adapter = adapterForAccount(account);
    expect(adapter.transport).toBe("composio");
    expect(adapter.provider).toBe("gmail");
  });

  it("resolves any account (no via) to the composio adapter", () => {
    const account: MailAccountRef = {
      provider: "outlook",
      mailEmail: "user@outlook.com",
    };
    const adapter = adapterForAccount(account);
    expect(adapter.transport).toBe("composio");
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

describe("Composio mutation guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Gmail Composio mutations disabled pending the mutation approval kernel", async () => {
    const adapter = resolveMailAdapter("gmail");
    const ctx = {
      userId: "uid",
      provider: "gmail" as const,
      mailEmail: "user@gmail.com",
      transport: "composio" as const,
      connectionId: "axis-connection-123",
    };
    const results = await Promise.all([
      adapter.markRead(ctx, "msg_1"),
      adapter.markUnread(ctx, "msg_1"),
      adapter.archiveMessage(ctx, "msg_1"),
      adapter.deleteMessage(ctx, "msg_1"),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
    }
    expect(mocks.markComposioGmailReadState).not.toHaveBeenCalled();
    expect(mocks.archiveComposioGmailMessage).not.toHaveBeenCalled();
    expect(mocks.trashComposioGmailMessage).not.toHaveBeenCalled();
  });

  it("returns structured not_supported for Gmail mutations", async () => {

    const adapter = resolveMailAdapter("gmail");
    const result = await adapter.markRead({
      userId: "uid",
      provider: "gmail",
      mailEmail: "user@gmail.com",
      transport: "composio",
      connectionId: "axis-connection-123",
    }, "msg_1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_supported");
      expect(result.error.provider).toBe("gmail");
      expect(result.error.transport).toBe("composio");
    }
  });

  it("keeps Outlook Composio actions disabled until live account validation exists", async () => {
    const adapter = resolveMailAdapter("outlook");
    const ctx = {
      userId: "uid",
      provider: "outlook" as const,
      mailEmail: "user@outlook.com",
      transport: "composio" as const,
      connectionId: "axis-connection-456",
    };

    const results = await Promise.all([
      adapter.markRead(ctx, "msg_1"),
      adapter.markUnread(ctx, "msg_1"),
      adapter.archiveMessage(ctx, "msg_1"),
      adapter.deleteMessage(ctx, "msg_1"),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("not_supported");
        expect(result.error.provider).toBe("outlook");
        expect(result.error.transport).toBe("composio");
      }
    }
  });
});
