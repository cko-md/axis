import { describe, expect, it } from "vitest";
import {
  ENTITY_REGISTRY,
  entityHref,
  entityRefKey,
  normalizeEntityRef,
  parseEntityRef,
  searchableEntityKinds,
  serializeEntityRef,
} from "@/lib/entities/registry";
import { ENTITY_KINDS, type EntityRef } from "@/lib/entities/types";

describe("entity registry", () => {
  it("covers every canonical entity kind with a usable route", () => {
    expect(Object.keys(ENTITY_REGISTRY).sort()).toEqual([...ENTITY_KINDS].sort());
    expect(searchableEntityKinds()).toEqual(ENTITY_KINDS);
    for (const kind of ENTITY_KINDS) {
      expect(ENTITY_REGISTRY[kind].route).toMatch(/^\//);
      expect(ENTITY_REGISTRY[kind].label).toBeTruthy();
    }
  });

  it("round-trips typed references and normalizes holding symbols", () => {
    const ref: EntityRef = { kind: "note", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect(parseEntityRef(serializeEntityRef(ref))).toEqual(ref);
    expect(entityRefKey(ref)).toBe("note:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(normalizeEntityRef({ kind: "holding", id: "brk.b" })).toEqual({ kind: "holding", id: "BRK.B" });
    expect(parseEntityRef("holding:brk.b")).toEqual({ kind: "holding", id: "BRK.B" });
  });

  it("rejects malformed and unknown references", () => {
    expect(parseEntityRef(null)).toBeNull();
    expect(parseEntityRef("note")).toBeNull();
    expect(parseEntityRef("unknown:123")).toBeNull();
    expect(parseEntityRef("note:")).toBeNull();
    expect(parseEntityRef("note:%E0%A4%A")).toBeNull();
    expect(parseEntityRef("note:not-a-uuid")).toBeNull();
  });

  it("uses entity deep links only where the destination consumes them", () => {
    expect(entityHref({ kind: "note", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toBe(
      "/notes",
    );
    expect(entityHref({ kind: "task", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toBe(
      "/tasks?task=task%3Aaaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(entityHref({ kind: "holding", id: "brk.b" })).toBe("/fund/position/BRK.B");
  });
});
