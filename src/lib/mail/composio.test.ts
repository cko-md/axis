import { describe, it, expect } from "vitest";
import {
  normalizeGmailMessage,
  normalizeOutlookMessage,
} from "./composio";

describe("normalizeGmailMessage()", () => {
  it("returns null for empty object", () => {
    expect(normalizeGmailMessage({}, "user@gmail.com")).toBeNull();
  });

  it("returns null when no id or messageId", () => {
    expect(normalizeGmailMessage({ threadId: "t1" }, "user@gmail.com")).toBeNull();
  });

  it("normalizes a raw Gmail API-shaped message with payload.headers", () => {
    const raw = {
      id: "msg1",
      threadId: "thread1",
      payload: {
        headers: [
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "Subject", value: "Hello" },
          { name: "Date", value: "Thu, 1 Jan 2025 00:00:00 +0000" },
        ],
      },
      snippet: "Hello there...",
      labelIds: ["INBOX", "UNREAD"],
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result).toEqual({
      id: "msg1",
      threadId: "thread1",
      from: "Alice <alice@example.com>",
      subject: "Hello",
      date: "2025-01-01T00:00:00.000Z",
      snippet: "Hello there...",
      isUnread: true,
      provider: "gmail",
      accountEmail: "user@gmail.com",
    });
  });

  it("uses messageId as id when id is absent", () => {
    const raw = { messageId: "alt-id", subject: "Test" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("alt-id");
  });

  it("falls back to flattened Composio fields when no payload headers", () => {
    const raw = {
      id: "msg2",
      sender: "bob@example.com",
      subject: "Fallback subject",
      messageTimestamp: "2025-01-01T00:00:00Z",
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result).not.toBeNull();
    expect(result!.from).toBe("bob@example.com");
    expect(result!.subject).toBe("Fallback subject");
    expect(result!.date).toBe("2025-01-01T00:00:00.000Z");
  });

  it("normalizes Gmail internalDate numeric strings", () => {
    const raw = { id: "msg-date", internalDate: "1735689600000" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.date).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns an empty date for invalid Gmail dates", () => {
    const raw = { id: "msg-bad-date", date: "definitely not a date" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.date).toBe("");
  });

  it("defaults subject to (no subject)", () => {
    const raw = { id: "msg3" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.subject).toBe("(no subject)");
  });

  it("defaults isUnread to false when no labelIds", () => {
    const raw = { id: "msg4" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.isUnread).toBe(false);
  });

  it("uses snippet from messageText when snippet is absent", () => {
    const raw = { id: "msg5", messageText: "This is a longer text that should be used as snippet" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.snippet).toContain("longer text");
  });

  it("falls back to id when threadId is missing", () => {
    const raw = { id: "msg6" };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.threadId).toBe("msg6");
  });
});

describe("normalizeOutlookMessage()", () => {
  it("returns null when id is missing", () => {
    expect(normalizeOutlookMessage({}, "user@outlook.com")).toBeNull();
  });

  it("normalizes a standard Outlook Graph-shaped message", () => {
    const raw = {
      id: "outlook1",
      conversationId: "conv1",
      from: {
        emailAddress: { name: "Charlie", address: "charlie@example.com" },
      },
      subject: "Meeting tomorrow",
      receivedDateTime: "2025-06-01T09:00:00Z",
      bodyPreview: "Let's meet at 3pm",
      isRead: false,
    };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result).toEqual({
      id: "outlook1",
      threadId: "conv1",
      from: "Charlie <charlie@example.com>",
      subject: "Meeting tomorrow",
      date: "2025-06-01T09:00:00.000Z",
      snippet: "Let's meet at 3pm",
      isUnread: true,
      provider: "outlook",
      accountEmail: "user@outlook.com",
    });
  });

  it("uses address-only from when no name", () => {
    const raw = {
      id: "outlook2",
      from: { emailAddress: { address: "no-name@example.com" } },
    };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.from).toBe("no-name@example.com");
  });

  it("handles missing from gracefully", () => {
    const raw = { id: "outlook3" };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.from).toBe("");
  });

  it("defaults subject to (no subject)", () => {
    const raw = { id: "outlook4" };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.subject).toBe("(no subject)");
  });

  it("isUnread is false when isRead is true", () => {
    const raw = { id: "outlook5", isRead: true };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.isUnread).toBe(false);
  });

  it("falls back to id when conversationId is missing", () => {
    const raw = { id: "outlook6" };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.threadId).toBe("outlook6");
  });

  it("isUnread is false when isRead is absent", () => {
    const raw = { id: "outlook7" };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.isUnread).toBe(false);
  });

  it("returns an empty date for invalid Outlook dates", () => {
    const raw = { id: "outlook8", receivedDateTime: "not a date" };
    const result = normalizeOutlookMessage(raw, "user@outlook.com");
    expect(result!.date).toBe("");
  });
});
