import { describe, expect, it } from "vitest";
import { extractBody, type GmailPayload } from "./gmail";

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("extractBody()", () => {
  it("prefers HTML over plain text in multipart messages", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain version") } },
        { mimeType: "text/html", body: { data: b64url("<p>html version</p>") } },
      ],
    };

    expect(extractBody(payload)).toEqual({
      content: "<p>html version</p>",
      isHtml: true,
    });
  });

  it("finds nested HTML parts before falling back to plain text", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("nested plain") } },
            { mimeType: "text/html", body: { data: b64url("<table><tr><td>nested html</td></tr></table>") } },
          ],
        },
      ],
    };

    expect(extractBody(payload)).toEqual({
      content: "<table><tr><td>nested html</td></tr></table>",
      isHtml: true,
    });
  });

  it("falls back to plain text when no HTML part exists", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain", body: { data: b64url("plain only") } }],
    };

    expect(extractBody(payload)).toEqual({
      content: "plain only",
      isHtml: false,
    });
  });

  it("matches parts whose mimeType carries parameters (text/html; charset=UTF-8)", () => {
    const payload: GmailPayload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain; charset=UTF-8", body: { data: b64url("plain with charset") } },
        { mimeType: "text/html; charset=UTF-8", body: { data: b64url("<p>html with charset</p>") } },
      ],
    };

    expect(extractBody(payload)).toEqual({
      content: "<p>html with charset</p>",
      isHtml: true,
    });
  });

  it("respects a parameterized mimeType on a single-part payload", () => {
    const payload: GmailPayload = {
      mimeType: "text/html; charset=iso-8859-1",
      body: { data: b64url("<b>single part</b>") },
    };

    expect(extractBody(payload)).toEqual({
      content: "<b>single part</b>",
      isHtml: true,
    });
  });
});
