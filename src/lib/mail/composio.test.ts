import { describe, it, expect } from "vitest";
import {
  normalizeGmailMessage,
  normalizeGmailMessageFull,
  normalizeOutlookMessage,
  normalizeOutlookMessageFull,
  GMAIL_FETCH_MESSAGE_SLUG,
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

  it("threads connectedAccountId when provided for multi-account Composio", () => {
    const raw = { id: "msg-ca", subject: "Hi" };
    const result = normalizeGmailMessage(raw, "user@gmail.com", "ca_xyz");
    expect(result!.connectedAccountId).toBe("ca_xyz");
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

  it("uses top-level headers array when payload.headers is absent", () => {
    const raw = {
      id: "msg-top-headers",
      headers: [
        { name: "From", value: "Dave <dave@example.com>" },
        { name: "Subject", value: "Top-level headers" },
        { name: "Date", value: "Thu, 1 Jan 2026 00:00:00 +0000" },
      ],
      labelIds: ["INBOX"],
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result).not.toBeNull();
    expect(result!.from).toBe("Dave <dave@example.com>");
    expect(result!.subject).toBe("Top-level headers");
  });

  it("normalises from as a Graph-API emailAddress object", () => {
    const raw = {
      id: "msg-from-obj",
      from: { emailAddress: { name: "Eve", address: "eve@example.com" } },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Eve <eve@example.com>");
  });

  it("normalises from as a flat {name, email} object", () => {
    const raw = {
      id: "msg-from-flat",
      from: { name: "Frank", email: "frank@example.com" },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Frank <frank@example.com>");
  });

  it("normalises sender as a Graph-API emailAddress object", () => {
    const raw = {
      id: "msg-sender-obj",
      sender: { emailAddress: { name: "Grace", address: "grace@example.com" } },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Grace <grace@example.com>");
  });

  it("never returns [object Object] for an unrecognised object sender", () => {
    const raw = { id: "msg-bad-sender", from: { some: "random", nested: "object" } };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).not.toContain("[object Object]");
  });
});

describe("GMAIL_FETCH_MESSAGE_SLUG", () => {
  it("is the verified primary Composio get-message slug", () => {
    expect(GMAIL_FETCH_MESSAGE_SLUG).toBe("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");
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

  it("decodes a native Gmail payload body (base64url) from a single-part message", () => {
    const html = "<p>Native payload body</p>";
    const bodyData = Buffer.from(html)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-native",
        payload: {
          mimeType: "text/html",
          headers: [
            { name: "From", value: "Alice <alice@example.com>" },
            { name: "Subject", value: "Native payload" },
          ],
          body: { data: bodyData },
        },
        labelIds: [],
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({ body: html, bodyIsHtml: true });
  });

  it("uses top-level headers for metadata when payload.headers is absent", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-top-hdr",
        headers: [
          { name: "From", value: "Bob <bob@example.com>" },
          { name: "Subject", value: "Top headers" },
        ],
        messageHtml: "<p>Body</p>",
        labelIds: [],
      },
      "user@gmail.com",
    );

    expect(result).not.toBeNull();
    expect(result!.from).toBe("Bob <bob@example.com>");
    expect(result!.subject).toBe("Top headers");
    expect(result!.bodyIsHtml).toBe(true);
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
