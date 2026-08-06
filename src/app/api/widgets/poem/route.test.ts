import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
}));

import { FALLBACK_POEMS } from "@/lib/content/poems";
import { GET } from "./route";

const originalFetch = global.fetch;

function request() {
  return new NextRequest("https://axis.test/api/widgets/poem?seed=17");
}

beforeEach(() => {
  mocks.addBreadcrumb.mockReset();
  mocks.captureException.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GET /api/widgets/poem", () => {
  it.each([
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("offline"))],
    ["503", () => Promise.resolve(new Response("{}", { status: 503 }))],
    ["404", () => Promise.resolve(new Response("{}", { status: 404 }))],
    ["malformed", () => Promise.resolve(new Response("not-json", { status: 200 }))],
    ["empty", () => Promise.resolve(Response.json([]))],
  ])("returns a deterministic bundled 200 for %s recovery", async (_case, implementation) => {
    global.fetch = vi.fn().mockImplementation(implementation);

    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=300, stale-while-revalidate=3600");
    expect(payload).toMatchObject({ source: "local" });
    expect(typeof payload.title).toBe("string");
    expect(typeof payload.author).toBe("string");
    expect(Array.isArray(payload.lines)).toBe(true);
    expect(payload.lines.length).toBeGreaterThan(0);
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: "provider.fallback",
      level: "warning",
      data: expect.objectContaining({
        area: "console",
        provider: "poetrydb",
        operation: "poem_fetch",
        code: "PROVIDER_FALLBACK",
        outcome: "degraded",
      }),
    }));
  });

  it("returns the provider payload with the long cache on success", async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json([{
      title: "Provider Poem",
      author: "Provider Poet",
      lines: ["Line one", "Line two"],
    }]));

    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=3600, stale-while-revalidate=86400");
    expect(payload).toEqual({
      title: "Provider Poem",
      author: "Provider Poet",
      lines: ["Line one", "Line two"],
      source: "poetrydb",
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: "PROVIDER_FALLBACK" }),
    }));
  });

  it("keeps every bundled fallback structurally valid", () => {
    expect(FALLBACK_POEMS.length).toBeGreaterThan(0);
    for (const poem of FALLBACK_POEMS) {
      expect(poem.source).toBe("local");
      expect(poem.title.trim()).not.toBe("");
      expect(poem.author.trim()).not.toBe("");
      expect(poem.lines.length).toBeGreaterThan(0);
      expect(poem.lines.every((line) => typeof line === "string")).toBe(true);
    }
  });
});
