import { describe, expect, it } from "vitest";
import { getCapabilities } from "@/lib/integrations/registry";
import { resolveMailAdapter } from "./index";
import type { IntegrationTransport } from "@/lib/integrations/types";
import type { MailProvider } from "../tokens";
import type { MailAccountContext } from "./types";

const MAIL_PROVIDER_MATRIX: Array<{
  provider: MailProvider;
  transport: IntegrationTransport;
  expected: {
    list: boolean;
    read: boolean;
    send: boolean;
    reply: boolean;
    markRead: boolean;
    archive: boolean;
    delete: boolean;
    attachmentDownload: boolean;
  };
}> = [
  {
    provider: "gmail",
    transport: "direct",
    expected: { list: true, read: true, send: true, reply: true, markRead: true, archive: true, delete: true, attachmentDownload: true },
  },
  {
    provider: "gmail",
    transport: "composio",
    expected: { list: true, read: true, send: true, reply: true, markRead: true, archive: true, delete: true, attachmentDownload: false },
  },
  {
    provider: "outlook",
    transport: "direct",
    expected: { list: true, read: true, send: true, reply: true, markRead: true, archive: true, delete: true, attachmentDownload: true },
  },
  {
    provider: "outlook",
    transport: "composio",
    expected: { list: true, read: true, send: true, reply: true, markRead: false, archive: false, delete: false, attachmentDownload: false },
  },
];

function contextFor(provider: MailProvider, transport: IntegrationTransport): MailAccountContext {
  return {
    userId: "user-1",
    provider,
    transport,
    mailEmail: provider === "gmail" ? "user@gmail.example" : "user@outlook.example",
    connectedAccountId: transport === "composio" ? "connected-account-1" : undefined,
  };
}

describe("mail provider parity matrix", () => {
  it.each(MAIL_PROVIDER_MATRIX)("$provider/$transport capabilities match the registry", ({ provider, transport, expected }) => {
    const adapter = resolveMailAdapter(provider, transport);
    const capabilities = getCapabilities("mail", provider, transport);

    expect(adapter.provider).toBe(provider);
    expect(adapter.transport).toBe(transport);
    expect(capabilities).toEqual(expected);
  });

  it.each(MAIL_PROVIDER_MATRIX)("implements every MailAdapter method for $provider/$transport", ({ provider, transport }) => {
    const adapter = resolveMailAdapter(provider, transport);

    expect(adapter.listInbox).toEqual(expect.any(Function));
    expect(adapter.getMessage).toEqual(expect.any(Function));
    expect(adapter.sendMessage).toEqual(expect.any(Function));
    expect(adapter.replyToMessage).toEqual(expect.any(Function));
    expect(adapter.markRead).toEqual(expect.any(Function));
    expect(adapter.markUnread).toEqual(expect.any(Function));
    expect(adapter.archiveMessage).toEqual(expect.any(Function));
    expect(adapter.deleteMessage).toEqual(expect.any(Function));
    expect(adapter.getAttachment).toEqual(expect.any(Function));
  });

  it("keeps unsupported Composio Outlook mutations structured and non-throwing", async () => {
    const adapter = resolveMailAdapter("outlook", "composio");
    const ctx = contextFor("outlook", "composio");
    const results = await Promise.all([
      adapter.markRead(ctx, "message-1"),
      adapter.markUnread(ctx, "message-1"),
      adapter.archiveMessage(ctx, "message-1"),
      adapter.deleteMessage(ctx, "message-1"),
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

  it.each([
    ["gmail", "composio"],
    ["outlook", "composio"],
  ] as const)("keeps unsupported %s/%s attachment download structured and non-throwing", async (provider, transport) => {
    const adapter = resolveMailAdapter(provider, transport);
    const result = await adapter.getAttachment(contextFor(provider, transport), "message-1", "attachment-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_supported");
      expect(result.error.provider).toBe(provider);
      expect(result.error.transport).toBe(transport);
    }
  });
});

