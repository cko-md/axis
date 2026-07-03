import { describe, expect, it } from "vitest";
import { normalizeSignalsAIRequest } from "./aiRequest";

describe("signals AI request parsing", () => {
  it("rejects malformed payloads", () => {
    expect(normalizeSignalsAIRequest(null)).toEqual({
      ok: false,
      error: "Invalid JSON payload",
      status: 400,
    });

    expect(normalizeSignalsAIRequest({ title: "" })).toEqual({
      ok: false,
      error: "title must be a non-empty string",
      status: 422,
    });
  });

  it("normalizes a single signal and bounds private fields", () => {
    const parsed = normalizeSignalsAIRequest({
      id: ` ${"i".repeat(250)} `,
      title: ` ${"t".repeat(600)} `,
      body: ` ${"b".repeat(4_200)} `,
      source: ` ${"s".repeat(250)} `,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.request.mode === "single") {
      expect(parsed.request.input.id).toHaveLength(200);
      expect(parsed.request.input.title).toHaveLength(500);
      expect(parsed.request.input.body).toHaveLength(4_000);
      expect(parsed.request.input.source).toHaveLength(200);
    }
  });

  it("validates batch shape and size", () => {
    expect(normalizeSignalsAIRequest({ mode: "batch", signals: "bad" })).toEqual({
      ok: false,
      error: "signals must be an array",
      status: 422,
    });

    expect(normalizeSignalsAIRequest({
      mode: "batch",
      signals: Array.from({ length: 51 }, (_, i) => ({ title: `Signal ${i}` })),
    })).toEqual({
      ok: false,
      error: "Batch size exceeds limit of 50",
      status: 400,
    });
  });

  it("normalizes valid batch signals", () => {
    const parsed = normalizeSignalsAIRequest({
      mode: "batch",
      signals: [{ id: "a", title: "A", body: null }, { id: "b", title: "B", source: "Mail" }],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.request.mode === "batch") {
      expect(parsed.request.signals).toEqual([
        { id: "a", title: "A", body: null, source: null },
        { id: "b", title: "B", body: null, source: "Mail" },
      ]);
    }
  });
});
