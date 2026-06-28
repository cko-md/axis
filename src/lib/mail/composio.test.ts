import { describe, it, expect } from "vitest";
import {
  normalizeGmailMessage,
  normalizeGmailMessageFull,
  normalizeOutlookMessage,
  normalizeOutlookMessageFull,
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
      date: "Thu, 1 Jan 2025 00:00:00 +0000",
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
    expect(result!.date).toBe("2025-01-01T00:00:00Z");
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
      date: "2025-06-01T09:00:00Z",
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
});

describe("normalizeGmailMessageFull()", () => {
  it("prefers flattened Composio HTML bodies over text fallbacks", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-1",
        subject: "Rendered email",
        messageHtml: "<p>Hello <a href=\"https://example.com\">there</a></p>",
        messageText: "Hello there",
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      body: "<p>Hello <a href=\"https://example.com\">there</a></p>",
      bodyIsHtml: true,
    });
  });

  it("treats generic Composio body strings that contain markup as HTML", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-2",
        body: "<div><img src=\"https://example.com/pixel.png\" alt=\"\" /></div>",
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      body: "<div><img src=\"https://example.com/pixel.png\" alt=\"\" /></div>",
      bodyIsHtml: true,
    });
  });

  it("preserves plain text bodies as non-HTML", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-3",
        bodyText: "Line one\nLine two",
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      body: "Line one\nLine two",
      bodyIsHtml: false,
    });
  });
});

describe("normalizeOutlookMessageFull()", () => {
  it("normalizes Outlook Graph HTML body objects", () => {
    const result = normalizeOutlookMessageFull(
      {
        id: "outlook-full-1",
        body: {
          contentType: "html",
          content: "<div><a href=\"https://example.com\">Open</a></div>",
        },
      },
      "user@outlook.com",
    );

    expect(result).toMatchObject({
      body: "<div><a href=\"https://example.com\">Open</a></div>",
      bodyIsHtml: true,
    });
  });

  it("falls back to bodyPreview as plain text", () => {
    const result = normalizeOutlookMessageFull(
      {
        id: "outlook-full-2",
        bodyPreview: "Preview line",
      },
      "user@outlook.com",
    );

    expect(result).toMatchObject({
      body: "Preview line",
      bodyIsHtml: false,
    });
  });
});
