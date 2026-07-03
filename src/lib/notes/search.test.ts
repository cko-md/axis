import { describe, expect, it } from "vitest";
import { filterNotesByKeyword, noteMatchesQuery, orderNotesBySemanticIds } from "@/lib/notes/search";
import type { Note } from "@/lib/hooks/useNotes";

function note(overrides: Partial<Note>): Note {
  return {
    id: "n1", user_id: "u1", title: "Untitled", body: "", folder: "Research", tags: [],
    sort_order: 0, created_at: "", updated_at: "", ...overrides,
  };
}

describe("noteMatchesQuery", () => {
  it("matches on title, case-insensitively", () => {
    expect(noteMatchesQuery({ title: "DBS Mechanism", body: "" }, "dbs")).toBe(true);
  });

  it("matches on plain-text body, ignoring HTML markup", () => {
    expect(noteMatchesQuery({ title: "Notes", body: "<p>connectivity <strong>profile</strong></p>" }, "connectivity profile")).toBe(true);
    expect(noteMatchesQuery({ title: "Notes", body: "<p>alpha</p>" }, "<strong>")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(noteMatchesQuery({ title: "x", body: "y" }, "   ")).toBe(true);
  });

  it("returns false when neither title nor body contains the query", () => {
    expect(noteMatchesQuery({ title: "Grants", body: "<p>aim 1</p>" }, "zebra")).toBe(false);
  });
});

describe("filterNotesByKeyword", () => {
  const notes = [
    note({ id: "a", title: "DBS Mechanism", body: "<p>connectivity</p>" }),
    note({ id: "b", title: "Grant Aims", body: "<p>split into arms</p>" }),
  ];

  it("returns all notes for a blank query", () => {
    expect(filterNotesByKeyword(notes, "")).toHaveLength(2);
  });

  it("filters to title or body matches", () => {
    expect(filterNotesByKeyword(notes, "connectivity").map((n) => n.id)).toEqual(["a"]);
    expect(filterNotesByKeyword(notes, "aims").map((n) => n.id)).toEqual(["b"]);
    expect(filterNotesByKeyword(notes, "zzz")).toEqual([]);
  });
});

describe("orderNotesBySemanticIds", () => {
  const notes = [note({ id: "a" }), note({ id: "b" }), note({ id: "c" })];

  it("orders notes by the provided id ranking and drops unknowns", () => {
    expect(orderNotesBySemanticIds(notes, ["c", "a", "missing"]).map((n) => n.id)).toEqual(["c", "a"]);
  });

  it("returns empty when no ids resolve", () => {
    expect(orderNotesBySemanticIds(notes, ["missing"])).toEqual([]);
  });
});
