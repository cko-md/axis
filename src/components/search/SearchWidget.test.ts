import { describe, expect, it } from "vitest";
import { parseEntityPreviewPayload, parseEntitySearchResponse } from "./SearchWidget";

const note = {
  ref: { kind: "note", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  title: "Alpha note",
  href: "/notes",
  meta: [{ label: "Updated", value: "Today" }],
};

describe("SearchWidget response boundaries", () => {
  it("accepts a normalized entity search response", () => {
    expect(parseEntitySearchResponse({
      version: 1,
      results: [{
        ...note,
        ranking: { text: 80, usage: 10, freshness: 5, total: 95, reasons: ["Title match"] },
      }],
      sources: [{ kind: "note", status: "ok", count: 1 }, { kind: "usage", status: "ok", count: 1 }],
      partial: false,
    })?.results[0]?.ref).toEqual(note.ref);
  });

  it("rejects unsafe or malformed search links and rankings", () => {
    const base = {
      version: 1,
      sources: [{ kind: "note", status: "ok", count: 1 }],
      partial: false,
    };
    expect(parseEntitySearchResponse({
      ...base,
      results: [{ ...note, href: "https://example.test", ranking: { text: 1, usage: 0, freshness: 0, total: 1, reasons: [] } }],
    })).toBeNull();
    expect(parseEntitySearchResponse({
      ...base,
      results: [{ ...note, ranking: { text: Number.NaN, usage: 0, freshness: 0, total: 1, reasons: [] } }],
    })).toBeNull();
  });

  it("accepts owner preview data and rejects malformed references", () => {
    expect(parseEntityPreviewPayload({
      entity: note,
      outgoing: [],
      backlinks: [],
      referencesStatus: "ok",
    })?.entity.title).toBe("Alpha note");

    expect(parseEntityPreviewPayload({
      entity: note,
      outgoing: [{ id: "bad" }],
      backlinks: [],
      referencesStatus: "ok",
    })).toBeNull();
  });
});
