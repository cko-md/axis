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

  it("reads headers hoisted to the top level when payload is absent", () => {
    const raw = {
      id: "msg-top-headers",
      headers: [
        { name: "From", value: "Dana <dana@example.com>" },
        { name: "Subject", value: "Top-level headers" },
      ],
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Dana <dana@example.com>");
    expect(result!.subject).toBe("Top-level headers");
  });

  it("reads headers flattened into an object map", () => {
    const raw = {
      id: "msg-map-headers",
      payload: {
        headers: {
          from: "Erin <erin@example.com>",
          subject: "Object-map headers",
          date: "Thu, 1 Jan 2025 00:00:00 +0000",
        },
      },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Erin <erin@example.com>");
    expect(result!.subject).toBe("Object-map headers");
    expect(result!.date).toBe("2025-01-01T00:00:00.000Z");
  });

  it("formats a from object as name <email> instead of [object Object]", () => {
    const raw = {
      id: "msg-from-obj",
      from: { name: "Frank", email: "frank@example.com" },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.from).toBe("Frank <frank@example.com>");
  });

  it("uses preview.body for the snippet when snippet is absent", () => {
    const raw = {
      id: "msg-preview",
      preview: { body: "Preview body text", subject: "ignored" },
    };
    const result = normalizeGmailMessage(raw, "user@gmail.com");
    expect(result!.snippet).toBe("Preview body text");
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

  it("prefers the native Gmail MIME payload (base64url parts) over flattened fields", () => {
    const b64url = (s: string) =>
      Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-payload",
        // Flattened fallback that should be ignored in favor of the payload.
        messageText: "flattened text should lose",
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "Payload wins" }],
          parts: [
            { mimeType: "text/plain", body: { data: b64url("plain part") } },
            { mimeType: "text/html", body: { data: b64url("<p>payload wins</p>") } },
          ],
        },
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      subject: "Payload wins",
      body: "<p>payload wins</p>",
      bodyIsHtml: true,
    });
  });

  it("falls back to the Composio `preview` object when no body field is present", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-preview",
        preview: { body: "Preview only body", subject: "Preview subject" },
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      body: "Preview only body",
      bodyIsHtml: false,
    });
  });

  it("falls back to the flattened attachmentList when the payload has no attachment parts", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-4",
        payload: {
          mimeType: "text/plain",
          body: { data: Buffer.from("hello").toString("base64") },
        },
        attachmentList: [
          { attachmentId: "att-9", filename: "notes.txt", mimeType: "text/plain", size: 12 },
        ],
      },
      "user@gmail.com",
    );

    expect(result!.attachments).toEqual([
      { id: "att-9", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12, inline: false },
    ]);
  });

  it("prefers native payload attachment parts over the flattened attachmentList", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-5",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              mimeType: "application/pdf",
              filename: "native.pdf",
              body: { attachmentId: "att-native", size: 100 },
            },
          ],
        },
        attachmentList: [{ attachmentId: "att-flat", filename: "flat.pdf" }],
      },
      "user@gmail.com",
    );

    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments![0]).toMatchObject({ id: "att-native", filename: "native.pdf" });
  });

  it("reads headers from a top-level headers array", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-6",
        headers: [
          { name: "From", value: "carol@example.com" },
          { name: "Subject", value: "Top-level headers" },
        ],
        bodyText: "Plain body",
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      from: "carol@example.com",
      subject: "Top-level headers",
      body: "Plain body",
    });
  });

  it("reads headers from a flat headers object map", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-7",
        headers: {
          From: "dave@example.com",
          Subject: "Mapped headers",
        },
        messageHtml: "<p>Mapped</p>",
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      from: "dave@example.com",
      subject: "Mapped headers",
      body: "<p>Mapped</p>",
      bodyIsHtml: true,
    });
  });

  it("decodes Gmail payload parts nested under data.payload", () => {
    const result = normalizeGmailMessageFull(
      {
        id: "gmail-full-8",
        data: {
          payload: {
            headers: [{ name: "Subject", value: "Nested payload" }],
            parts: [{ mimeType: "text/plain", body: { data: "TmVzdGVk" } }],
          },
        },
      },
      "user@gmail.com",
    );

    expect(result).toMatchObject({
      subject: "Nested payload",
      body: "Nested",
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
