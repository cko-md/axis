import { describe, expect, it } from "vitest";
import { compareRankedEntities, rankEntity } from "@/lib/entities/ranking";
import type { EntitySummary } from "@/lib/entities/types";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function entity(title: string, updatedAt = "2026-07-10T12:00:00.000Z"): EntitySummary {
  return {
    ref: { kind: "note", id: title },
    title,
    href: `/notes?note=${title}`,
    updatedAt,
    meta: [],
  };
}

describe("entity frecency ranking", () => {
  it("makes exact and prefix matches stronger than substring matches", () => {
    const exact = rankEntity("alpha", entity("Alpha"), undefined, NOW);
    const prefix = rankEntity("alpha", entity("Alpha plan"), undefined, NOW);
    const contains = rankEntity("alpha", entity("Project alpha plan"), undefined, NOW);
    expect(exact.text).toBeGreaterThan(prefix.text);
    expect(prefix.text).toBeGreaterThan(contains.text);
  });

  it("adds an inspectable deterministic usage and recency contribution", () => {
    const ranking = rankEntity(
      "plan",
      entity("Plan"),
      { useCount: 7, lastUsedAt: "2026-07-16T06:00:00.000Z", lastAction: "search" },
      NOW,
    );
    expect(ranking).toEqual({
      text: 100,
      usage: 38,
      freshness: 6,
      total: 144,
      reasons: ["Exact title match", "Opened 7 times", "Used recently", "Updated this week"],
    });
  });

  it("does not reward absent or invalid freshness timestamps", () => {
    expect(rankEntity("plan", entity("Plan", "invalid"), undefined, NOW).freshness).toBe(0);
  });

  it("uses stable title/kind/id tie breakers", () => {
    const beta = { ...entity("Beta"), ranking: rankEntity("note", entity("Beta"), undefined, NOW) };
    const alpha = { ...entity("Alpha"), ranking: rankEntity("note", entity("Alpha"), undefined, NOW) };
    expect([beta, alpha].sort(compareRankedEntities).map((item) => item.title)).toEqual(["Alpha", "Beta"]);
  });
});
