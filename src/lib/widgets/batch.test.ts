import { describe, expect, it } from "vitest";
import {
  cachedWidgetRowToBatchWidget,
  dedupeWidgetIds,
  maxWidgetsPerBatch,
  safeWidgetBatchError,
  statusForWidgetPayload,
  widgetProviderTimeoutMs,
} from "@/lib/widgets/batch";
import type { WidgetCacheRow } from "@/lib/widgets/cache";

const cachedWeather: WidgetCacheRow = {
  widget_id: "weather",
  cache_key: "weather",
  status: "fresh",
  value: "72°F",
  hint: "Home",
  raw: { temp: 72 },
  error: null,
  fetched_at: "2026-07-01T11:59:00Z",
  expires_at: "2026-07-01T12:10:00Z",
};

describe("widget batch contract", () => {
  it("dedupes, trims, drops empty ids, and caps batch size", () => {
    const ids = [" weather ", "weather", "", "agenda", ...Array.from({ length: 40 }, (_, index) => `w${index}`)];

    const result = dedupeWidgetIds(ids);

    expect(result.slice(0, 2)).toEqual(["weather", "agenda"]);
    expect(result).toHaveLength(maxWidgetsPerBatch);
  });

  it("maps provider payload flags into widget statuses", () => {
    expect(statusForWidgetPayload({ error: true, partial: true }, "lab")).toEqual("error");
    expect(statusForWidgetPayload({ partial: true }, "lab")).toEqual("stale");
    expect(statusForWidgetPayload({ fallback: true }, "setup_required")).toEqual("setup_required");
    expect(statusForWidgetPayload({}, "lab")).toEqual("fresh");
  });

  it("keeps provider timeout tiers explicit", () => {
    expect(widgetProviderTimeoutMs("open-meteo")).toBe(4_500);
    expect(widgetProviderTimeoutMs("massive")).toBe(5_500);
    expect(widgetProviderTimeoutMs("polygon")).toBe(5_500);
    expect(widgetProviderTimeoutMs("strava")).toBe(5_500);
    expect(widgetProviderTimeoutMs("supabase")).toBe(3_000);
    expect(widgetProviderTimeoutMs("local")).toBe(2_000);
  });

  it("omits unknown HTTP status from safe error payloads", () => {
    expect(safeWidgetBatchError("WIDGET_FETCH_FAILED", "Widget fetch failed", true)).toEqual({
      code: "WIDGET_FETCH_FAILED",
      message: "Widget fetch failed",
      retryable: true,
    });
    expect(safeWidgetBatchError("PROVIDER_TIMEOUT", "Widget provider timed out", true, 504)).toMatchObject({
      status: 504,
    });
  });

  it("maps cached rows to stale batch widgets after a refresh failure", () => {
    expect(cachedWidgetRowToBatchWidget(cachedWeather)).toMatchObject({
      id: "weather",
      status: "stale",
      value: "72°F",
      hint: "Home · refresh failed",
      raw: { temp: 72 },
      fallback: true,
      fetchedAt: "2026-07-01T11:59:00Z",
      source: expect.objectContaining({ cacheKey: "weather" }),
    });
    expect(cachedWidgetRowToBatchWidget({ ...cachedWeather, cache_key: "wrong" })).toBeNull();
  });
});
