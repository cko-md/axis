import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  DEFAULT_READER_SCALE,
  formatAttachmentSize,
  formatMessageTimestamp,
  isReaderScale,
  nextReaderScale,
  parseSenderParts,
  READER_SCALES,
  replyAddress,
  replySubject,
  sanitizeMailHtml,
  SENDER_TONES,
  senderInitials,
  senderTone,
  stripMailHtml,
} from "@/lib/mail/reader";

describe("sanitizeMailHtml", () => {
  it("strips scripts, event handlers, and embedded frames", () => {
    const dirty =
      '<p onclick="steal()">Hi</p><script>steal()</script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input></form>';
    const clean = sanitizeMailHtml(dirty, true);
    expect(clean).toContain("Hi");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("iframe");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("<form");
  });

  it("blocks external images until the user opts in", () => {
    const html = '<img src="https://tracker.test/pixel.png"><p>Body</p>';
    const blocked = sanitizeMailHtml(html, false);
    expect(blocked).not.toContain("tracker.test");
    const allowed = sanitizeMailHtml(html, true);
    expect(allowed).toContain("tracker.test");
  });

  it("forces links to open in a new tab with noopener", () => {
    const clean = sanitizeMailHtml('<a href="https://example.com" target="_top">x</a>', false);
    expect(clean).toContain('target="_blank"');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).not.toContain("_top");
  });
});

describe("stripMailHtml", () => {
  it("flattens markup and entities into readable text", () => {
    expect(stripMailHtml("<style>p{}</style><p>A&nbsp;&amp;&nbsp;B</p> <div>C</div>")).toBe("A & B C");
  });
});

describe("attachment formatting", () => {
  it("labels common attachment types", () => {
    expect(attachmentKind("application/pdf")).toBe("PDF");
    expect(attachmentKind("image/png")).toBe("Image");
    expect(attachmentKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("Sheet");
    expect(attachmentKind("application/vnd.ms-powerpoint")).toBe("Deck");
    expect(attachmentKind("application/msword")).toBe("Doc");
    expect(attachmentKind("application/zip")).toBe("File");
  });

  it("formats byte sizes", () => {
    expect(formatAttachmentSize(undefined)).toBe("Unknown size");
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(2048)).toBe("2.0 KB");
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("reply helpers", () => {
  it("prefixes Re: exactly once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject("re : Hello")).toBe("re : Hello");
  });

  it("extracts the reply address from a display-name header", () => {
    expect(replyAddress("Jane Poe <jane@example.com>")).toBe("jane@example.com");
    expect(replyAddress("jane@example.com")).toBe("jane@example.com");
  });
});

describe("sender identity", () => {
  it("splits display name and address", () => {
    expect(parseSenderParts('"Jane Poe" <jane@example.com>')).toEqual({
      name: "Jane Poe",
      email: "jane@example.com",
    });
    expect(parseSenderParts("jane@example.com")).toEqual({
      name: "jane@example.com",
      email: "jane@example.com",
    });
  });

  it("builds initials from names and bare addresses", () => {
    expect(senderInitials("Jane Poe <jane@example.com>")).toBe("JP");
    expect(senderInitials("Jane Q. Public <j@example.com>")).toBe("JP");
    expect(senderInitials("jane@example.com")).toBe("JA");
    expect(senderInitials("")).toBe("?");
  });

  it("assigns a stable tone per sender", () => {
    const tone = senderTone("Jane Poe <jane@example.com>");
    expect(SENDER_TONES).toContain(tone);
    expect(senderTone("jane@example.com")).toBe(tone);
    expect(senderTone("JANE POE <jane@example.com>")).toBe(tone);
  });
});

describe("formatMessageTimestamp", () => {
  it("renders a full explicit timestamp", () => {
    const out = formatMessageTimestamp("2026-07-02T15:41:00.000Z");
    expect(out).toContain("2026");
    expect(out).not.toBe("Unknown date");
  });

  it("falls back safely on unparseable dates", () => {
    expect(formatMessageTimestamp("not-a-date")).toBe("Unknown date");
    expect(formatMessageTimestamp("")).toBe("Unknown date");
  });
});

describe("reader scale", () => {
  it("cycles through every scale and wraps", () => {
    expect(nextReaderScale("compact")).toBe("comfortable");
    expect(nextReaderScale("comfortable")).toBe("large");
    expect(nextReaderScale("large")).toBe("compact");
  });

  it("validates stored values", () => {
    expect(isReaderScale("comfortable")).toBe(true);
    expect(isReaderScale("huge")).toBe(false);
    expect(isReaderScale(null)).toBe(false);
    expect(READER_SCALES[DEFAULT_READER_SCALE]).toBeDefined();
  });
});
