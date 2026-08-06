import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
  captureMessage: mocks.captureMessage,
}));

import { FALLBACK_POEMS } from "@/lib/content/poems";
import { GET } from "./route";

const originalFetch = global.fetch;

function request() {
  return new NextRequest("https://axis.test/api/widgets/poem?seed=17");
}

function requestForSeed(seed: number) {
  return new NextRequest(`https://axis.test/api/widgets/poem?seed=${seed}`);
}

beforeEach(() => {
  mocks.addBreadcrumb.mockReset();
  mocks.captureException.mockReset();
  mocks.captureMessage.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GET /api/widgets/poem", () => {
  it.each([
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError")), "PROVIDER_TIMEOUT", 504, "exception"],
    ["network", () => Promise.reject(new TypeError("offline")), "network", undefined, "exception"],
    ["503", () => Promise.resolve(new Response("{}", { status: 503 })), "provider_error", 503, "exception"],
    ["404", () => Promise.resolve(new Response("private-body", { status: 404 })), "not_found", 404, "message"],
    ["429", () => Promise.resolve(new Response("private-body", { status: 429 })), "rate_limited", 429, "message"],
    ["malformed", () => Promise.resolve(new Response("not-json", { status: 200 })), "INVALID_RESPONSE", undefined, "exception"],
    ["empty", () => Promise.resolve(Response.json([])), "INVALID_RESPONSE", undefined, "exception"],
    ["error envelope", () => Promise.resolve(Response.json({ status: 404 })), "not_found", 404, "message"],
    ["invalid status envelope", () => Promise.resolve(Response.json({ status: 200 })), "INVALID_RESPONSE", undefined, "exception"],
    ["invalid shape", () => Promise.resolve(Response.json([{ title: "Private title", author: "Private author", lines: [7] }])), "INVALID_RESPONSE", undefined, "exception"],
    ["oversized declared body", () => Promise.resolve(new Response("[]", { headers: { "content-length": "262145" } })), "INVALID_RESPONSE", undefined, "exception"],
    ["oversized streamed body", () => Promise.resolve(new Response(new Uint8Array(262_145))), "INVALID_RESPONSE", undefined, "exception"],
    ["excess result count", () => Promise.resolve(Response.json(Array.from({ length: 26 }, () => ({ title: "Title", author: "Author", lines: ["Line"] })))), "INVALID_RESPONSE", undefined, "exception"],
  ])("returns a deterministic bundled 200 for %s recovery", async (_case, implementation, code, status, captureKind) => {
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
    expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: "provider.fallback",
      level: captureKind === "message" ? "info" : "warning",
      data: expect.objectContaining({
        area: "console",
        provider: "poetrydb",
        operation: "poem_fetch",
        code,
        ...(status !== undefined ? { status } : {}),
        outcome: "degraded",
        fallback: true,
      }),
    }));
    if (captureKind === "message") {
      expect(mocks.captureException).not.toHaveBeenCalled();
      expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
      expect(mocks.captureMessage).toHaveBeenCalledWith(
        "poetrydb poem_fetch degraded",
        expect.objectContaining({
          level: "info",
          tags: expect.objectContaining({ code }),
        }),
      );
    } else {
      expect(mocks.captureMessage).not.toHaveBeenCalled();
      expect(mocks.captureException).toHaveBeenCalledTimes(1);
      expect(mocks.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: `poetrydb poem_fetch failed: ${code}` }),
        expect.objectContaining({ tags: expect.objectContaining({ code }) }),
      );
    }
    expect(JSON.stringify([
      mocks.captureException.mock.calls,
      mocks.captureMessage.mock.calls,
      mocks.addBreadcrumb.mock.calls,
    ])).not.toMatch(/timed out|offline|not-json|private-body|Private title|Private author/);
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
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: "PROVIDER_FALLBACK" }),
    }));
  });

  it("emits only the route-owned fallback breadcrumb for a slow provider failure", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2_000);
    global.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: "provider.fallback",
      level: "warning",
    }));
  });

  it("keeps explicit seed zero deterministic across fallback requests", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("offline"));

    const first = await GET(requestForSeed(0));
    const second = await GET(requestForSeed(0));

    expect(await first.json()).toEqual(await second.json());
    expect(mocks.captureException).toHaveBeenCalledTimes(2);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it.each([0, -1, 399, 600])("rejects out-of-range status envelope %s as an invalid payload", async (status) => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({ status }));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "poetrydb poem_fetch failed: INVALID_RESPONSE" }),
      expect.objectContaining({ tags: expect.objectContaining({ code: "INVALID_RESPONSE" }) }),
    );
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
