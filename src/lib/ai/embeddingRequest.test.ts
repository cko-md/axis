import { describe, expect, it } from "vitest";
import { normalizeEmbeddingPayload, normalizeSemanticQuery } from "./embeddingRequest";

describe("AI embedding request parsing", () => {
  it("rejects malformed embedding payloads", () => {
    expect(normalizeEmbeddingPayload(null)).toEqual({
      ok: false,
      error: "Invalid JSON payload",
      status: 400,
    });

    expect(normalizeEmbeddingPayload({ noteId: "note-1", text: 42 })).toEqual({
      ok: false,
      error: "text must be a non-empty string",
      status: 422,
    });
  });

  it("trims and caps private embedding text before provider calls", () => {
    const parsed = normalizeEmbeddingPayload({
      noteId: " note-1 ",
      text: ` ${"a".repeat(12_050)} `,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.noteId).toBe("note-1");
      expect(parsed.payload.text).toHaveLength(12_000);
    }
  });

  it("rejects empty semantic queries", () => {
    expect(normalizeSemanticQuery("   ")).toEqual({
      ok: false,
      error: "Missing query param q",
      status: 400,
    });
  });

  it("caps semantic query text before provider calls", () => {
    const parsed = normalizeSemanticQuery(` ${"q".repeat(700)} `);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query).toHaveLength(500);
    }
  });
});
