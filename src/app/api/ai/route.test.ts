import { describe, expect, it } from "vitest";
import { normalizePayload, parseJsonBody } from "@/lib/ai/request";

describe("AI route request parsing", () => {
  it("rejects malformed outer payloads before mode handling", () => {
    expect(normalizePayload(null)).toEqual({
      ok: false,
      error: "Invalid JSON payload",
      status: 400,
    });
  });

  it("defaults missing mode to capture while requiring text to be a string", () => {
    expect(normalizePayload({ text: "capture this" })).toEqual({
      ok: true,
      payload: { mode: "capture", text: "capture this", body: undefined, title: undefined },
    });

    expect(normalizePayload({ mode: "triage", text: 123 })).toEqual({
      ok: false,
      error: "text must be a string",
      status: 422,
    });
  });

  it("rejects non-string nested body and title values", () => {
    expect(normalizePayload({ mode: "route", text: "note", body: { unsafe: true } })).toEqual({
      ok: false,
      error: "body must be a string",
      status: 422,
    });

    expect(normalizePayload({ mode: "route", text: "note", title: ["bad"] })).toEqual({
      ok: false,
      error: "title must be a string",
      status: 422,
    });
  });

  it("caps long private text fields at the route boundary", () => {
    const parsed = normalizePayload({
      mode: "notes-summarize",
      text: "a".repeat(20_050),
      body: "b".repeat(20_050),
      title: "c".repeat(550),
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.text).toHaveLength(20_000);
      expect(parsed.payload.body).toHaveLength(20_000);
      expect(parsed.payload.title).toHaveLength(500);
    }
  });

  it("uses fallback context when nested body JSON is invalid", () => {
    expect(parseJsonBody<{ topics: string[] }>("{not json", { topics: [] })).toEqual({ topics: [] });
    expect(parseJsonBody<{ topics: string[] }>("{\"topics\":[\"dbs\"]}", { topics: [] })).toEqual({ topics: ["dbs"] });
  });
});
