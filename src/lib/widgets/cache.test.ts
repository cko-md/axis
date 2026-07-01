import { describe, expect, it } from "vitest";
import {
  isWidgetCacheStale,
  widgetCacheRowMatchesDefinition,
  widgetCacheRowToData,
  widgetRefreshFailureData,
  widgetStaleHint,
  type WidgetCacheRow,
} from "@/lib/widgets/cache";

const now = new Date("2026-07-01T12:00:00Z").getTime();

const baseRow: WidgetCacheRow = {
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

describe("widget cache normalization", () => {
  it("marks cache rows stale only after their expiration time", () => {
    expect(isWidgetCacheStale("2026-07-01T12:10:00Z", now)).toBe(false);
    expect(isWidgetCacheStale("2026-07-01T11:59:00Z", now)).toBe(true);
    expect(isWidgetCacheStale(null, now)).toBe(true);
  });

  it("matches cache rows to the registry cache key", () => {
    expect(widgetCacheRowMatchesDefinition(baseRow)).toBe(true);
    expect(widgetCacheRowMatchesDefinition({ ...baseRow, cache_key: "other-cache" })).toBe(false);
    expect(widgetCacheRowMatchesDefinition({ ...baseRow, widget_id: "unknown" })).toBe(false);
  });

  it("maps cache rows into widget data without losing stale/error/fallback state", () => {
    expect(widgetCacheRowToData(baseRow, now)).toMatchObject({
      v: "72°F",
      k: "Home",
      raw: { temp: 72 },
      error: false,
      stale: false,
      loading: false,
      updatedAt: "2026-07-01T11:59:00Z",
    });

    expect(widgetCacheRowToData({ ...baseRow, status: "setup_required", value: null, hint: null }, now)).toMatchObject({
      fallback: true,
      v: expect.any(String),
      k: expect.any(String),
    });

    expect(widgetCacheRowToData({ ...baseRow, status: "error", error: { code: "X" } }, now)).toMatchObject({
      error: true,
    });
  });

  it("appends refresh-failed copy only once", () => {
    expect(widgetStaleHint("Home")).toEqual("Home · refresh failed");
    expect(widgetStaleHint("Home · refresh failed")).toEqual("Home · refresh failed");
  });

  it("preserves previous widget values on refresh failure", () => {
    expect(widgetRefreshFailureData("weather", {
      v: "72°F",
      k: "Home",
      raw: { temp: 72 },
      updatedAt: "2026-07-01T11:59:00Z",
    })).toMatchObject({
      v: "72°F",
      k: "Home · refresh failed",
      raw: { temp: 72 },
      error: true,
      stale: true,
      loading: false,
      updatedAt: "2026-07-01T11:59:00Z",
    });
  });

  it("falls back to the catalog value when refresh fails without cache", () => {
    expect(widgetRefreshFailureData("weather")).toMatchObject({
      v: expect.any(String),
      k: expect.stringContaining("refresh failed"),
      error: true,
      stale: false,
      loading: false,
    });
  });
});
