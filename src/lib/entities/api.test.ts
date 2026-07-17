import { describe, expect, it } from "vitest";
import {
  createEntityReferenceSchema,
  entityRefSchema,
  parseEntityPath,
  parseEntitySearchQuery,
  recordEntityUsageSchema,
} from "@/lib/entities/api";

const NOTE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("entity API contracts", () => {
  it("normalizes valid holding references and rejects malformed UUID references", () => {
    expect(entityRefSchema.parse({ kind: "holding", id: "brk.b" })).toEqual({ kind: "holding", id: "BRK.B" });
    expect(entityRefSchema.safeParse({ kind: "note", id: "not-a-uuid" }).success).toBe(false);
    expect(parseEntityPath("unknown", NOTE_ID)).toBeNull();
  });

  it("accepts strict non-self references and bounded labels", () => {
    expect(createEntityReferenceSchema.parse({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
      relation: "supports",
      label: "Evidence",
    })).toMatchObject({ relation: "supports", label: "Evidence" });
    expect(createEntityReferenceSchema.safeParse({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "note", id: NOTE_ID },
    }).success).toBe(false);
    expect(createEntityReferenceSchema.safeParse({
      source: { kind: "note", id: NOTE_ID },
      target: { kind: "task", id: TASK_ID },
      canExecute: true,
    }).success).toBe(false);
  });

  it("accepts only explicit usage channels", () => {
    expect(recordEntityUsageSchema.parse({ action: "search" })).toEqual({ action: "search" });
    expect(recordEntityUsageSchema.safeParse({ action: "preview" }).success).toBe(false);
  });

  it("parses bounded search filters and rejects unknown kinds or limits", () => {
    expect(parseEntitySearchQuery(new URLSearchParams("q=alpha&types=note,task&limit=10"))).toEqual({
      query: "alpha",
      kinds: ["note", "task"],
      limit: 10,
    });
    expect(parseEntitySearchQuery(new URLSearchParams("q=a"))).toBeNull();
    expect(parseEntitySearchQuery(new URLSearchParams("q=alpha&types=note,unknown"))).toBeNull();
    expect(parseEntitySearchQuery(new URLSearchParams("q=alpha&limit=100"))).toBeNull();
  });
});
