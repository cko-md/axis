import { ENTITY_REGISTRY } from "@/lib/entities/registry";
import type { EntityRanking, EntitySummary, EntityUsage } from "@/lib/entities/types";

const DAY_MS = 86_400_000;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatchScore(query: string, entity: EntitySummary): { score: number; reason: string } {
  const title = normalize(entity.title);
  const subtitle = normalize(entity.subtitle ?? "");
  const kindLabel = normalize(
    `${ENTITY_REGISTRY[entity.ref.kind].label} ${ENTITY_REGISTRY[entity.ref.kind].pluralLabel}`,
  );

  if (title === query) return { score: 100, reason: "Exact title match" };
  if (title.startsWith(query)) return { score: 82, reason: "Title prefix match" };
  if (title.split(" ").some((word) => word.startsWith(query))) {
    return { score: 66, reason: "Title word-prefix match" };
  }
  if (title.includes(query)) return { score: 50, reason: "Title contains query" };
  if (subtitle.includes(query)) return { score: 28, reason: "Metadata contains query" };
  if (kindLabel.includes(query)) return { score: 20, reason: "Entity type match" };
  return { score: 0, reason: "No text match" };
}

function usageScore(usage: EntityUsage | undefined, nowMs: number): { score: number; reasons: string[] } {
  if (!usage || usage.useCount <= 0) return { score: 0, reasons: [] };
  const frequency = Math.min(30, Math.round(Math.log2(usage.useCount + 1) * 6));
  const reasons = [`Opened ${usage.useCount} ${usage.useCount === 1 ? "time" : "times"}`];
  if (!usage.lastUsedAt) return { score: frequency, reasons };

  const ageMs = Math.max(0, nowMs - new Date(usage.lastUsedAt).getTime());
  let recency = 0;
  if (ageMs <= DAY_MS) recency = 20;
  else if (ageMs <= 7 * DAY_MS) recency = 14;
  else if (ageMs <= 30 * DAY_MS) recency = 8;
  else if (ageMs <= 90 * DAY_MS) recency = 3;
  if (recency > 0) reasons.push("Used recently");
  return { score: frequency + recency, reasons };
}

function freshnessScore(updatedAt: string | undefined, nowMs: number): { score: number; reason?: string } {
  if (!updatedAt) return { score: 0 };
  const updatedMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return { score: 0 };
  const ageMs = Math.max(0, nowMs - updatedMs);
  if (ageMs <= DAY_MS) return { score: 10, reason: "Updated today" };
  if (ageMs <= 7 * DAY_MS) return { score: 6, reason: "Updated this week" };
  if (ageMs <= 30 * DAY_MS) return { score: 3, reason: "Updated this month" };
  return { score: 0 };
}

export function rankEntity(
  rawQuery: string,
  entity: EntitySummary,
  usage?: EntityUsage,
  now = new Date(),
): EntityRanking {
  const query = normalize(rawQuery);
  const text = textMatchScore(query, entity);
  const usagePart = usageScore(usage, now.getTime());
  const freshness = freshnessScore(entity.updatedAt, now.getTime());
  const reasons = [text.reason, ...usagePart.reasons, ...(freshness.reason ? [freshness.reason] : [])];
  return {
    text: text.score,
    usage: usagePart.score,
    freshness: freshness.score,
    total: text.score + usagePart.score + freshness.score,
    reasons,
  };
}

export function compareRankedEntities(
  a: EntitySummary & { ranking: EntityRanking },
  b: EntitySummary & { ranking: EntityRanking },
): number {
  return (
    b.ranking.total - a.ranking.total ||
    a.title.localeCompare(b.title) ||
    a.ref.kind.localeCompare(b.ref.kind) ||
    a.ref.id.localeCompare(b.ref.id)
  );
}
