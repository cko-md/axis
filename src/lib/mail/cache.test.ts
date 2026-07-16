import { describe, expect, it } from "vitest";
import type { MailMessage } from "./gmail";
import type { MailAccountRef } from "./tokens";
import {
  mailAccountRef,
  mailAccountTransport,
  messageFromCacheRow,
  messageToCacheInsert,
} from "./cache";

const direct: MailAccountRef = {
  provider: "gmail",
  mailEmail: "Owner@Example.com",
};
const composio: MailAccountRef = {
  provider: "outlook",
  mailEmail: "Connected account",
  via: "composio",
  connectedAccountId: "ca_stable_123",
};
const message: MailMessage = {
  id: "message_1",
  threadId: "thread_1",
  from: "Sender <sender@example.com>",
  subject: "Status update",
  date: "2026-07-15T20:00:00.000Z",
  snippet: "A bounded preview",
  isUnread: true,
  provider: "gmail",
  accountEmail: "Owner@Example.com",
};

describe("mail cache mapping", () => {
  it("uses a normalized address for direct accounts and an opaque id for Composio", () => {
    expect(mailAccountRef(direct)).toBe("owner@example.com");
    expect(mailAccountTransport(direct)).toBe("direct");
    expect(mailAccountRef(composio)).toBe("ca_stable_123");
    expect(mailAccountTransport(composio)).toBe("composio");
  });

  it("stores list metadata without message bodies or attachments", () => {
    const row = messageToCacheInsert(
      "user_1",
      direct,
      { ...message, body: "private body", attachments: [{ id: "a1" }] } as MailMessage,
      "generation_1",
      "2026-07-15T20:01:00.000Z",
    );

    expect(row).toMatchObject({
      user_id: "user_1",
      provider_message_id: "message_1",
      sender: message.from,
      subject: message.subject,
      snippet: message.snippet,
      received_at: message.date,
    });
    expect(row).not.toHaveProperty("body");
    expect(row).not.toHaveProperty("attachments");
  });

  it("keeps the original provider date while making invalid dates unsortable", () => {
    const row = messageToCacheInsert(
      "user_1",
      direct,
      { ...message, date: "provider-date-unavailable" },
      "generation_1",
      "2026-07-15T20:01:00.000Z",
    );

    expect(row.message_date).toBe("provider-date-unavailable");
    expect(row.received_at).toBeNull();
  });

  it("round-trips normalized inbox metadata", () => {
    const row = messageToCacheInsert(
      "user_1",
      composio,
      { ...message, provider: "outlook", accountEmail: composio.mailEmail },
      "generation_1",
      "2026-07-15T20:01:00.000Z",
    );

    expect(messageFromCacheRow(row as Parameters<typeof messageFromCacheRow>[0])).toEqual({
      ...message,
      provider: "outlook",
      accountEmail: "Connected account",
      connectedAccountId: "ca_stable_123",
    });
  });
});
