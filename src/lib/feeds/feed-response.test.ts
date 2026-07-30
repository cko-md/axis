import { describe, expect, it } from "vitest";
import { parseFeedResponse } from "./feed-response";

describe("parseFeedResponse", () => {
  it("keeps usable items while exposing a partial stale/failed result", () => {
    expect(parseFeedResponse<{ title: string }>({
      items: [{ title: "Cached article" }],
      sources: [{ host: "example.test", state: "stale", code: "SAFE_FETCH_TIMEOUT" }],
      partial: true,
    })).toMatchObject({ items: [{ title: "Cached article" }], partial: true, allFailed: false });
  });

  it("distinguishes an all-failed HTTP 200 payload from a genuine empty result", () => {
    expect(parseFeedResponse({
      items: [],
      sources: [{ host: "example.test", state: "failed", code: "SAFE_FETCH_DNS_FAILED" }],
      partial: true,
    })).toMatchObject({ items: [], partial: true, allFailed: true });
    expect(parseFeedResponse({ items: [], sources: [{ host: "example.test", state: "live" }], partial: false }))
      .toMatchObject({ partial: false, allFailed: false });
  });
});
