export type FeedSourceState = "cached" | "live" | "stale" | "failed";

export type FeedSource = {
  host: string;
  state: FeedSourceState;
  code?: string;
};

export type FeedResponse<T> = {
  items: T[];
  sources: FeedSource[];
  partial: boolean;
  allFailed: boolean;
};

export function parseFeedResponse<T>(value: unknown): FeedResponse<T> {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(data.items) ? data.items as T[] : [];
  const sources = Array.isArray(data.sources)
    ? data.sources.filter((source): source is FeedSource => !!source
      && typeof source === "object"
      && typeof (source as FeedSource).host === "string"
      && ["cached", "live", "stale", "failed"].includes((source as FeedSource).state))
    : [];
  const partial = data.partial === true || sources.some((source) => source.state === "stale" || source.state === "failed");
  return {
    items,
    sources,
    partial,
    allFailed: sources.length > 0 && sources.every((source) => source.state === "failed"),
  };
}
