import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), safeFetch: vi.fn(), addBreadcrumb: vi.fn(), captureException: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/security/safe-fetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/safe-fetch")>(),
  safeFetch: mocks.safeFetch,
}));
vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: mocks.addBreadcrumb, captureException: mocks.captureException }));
vi.mock("@/lib/web-reader", () => ({ extractReadableArticle: vi.fn() }));

import { SafeFetchError } from "@/lib/security/safe-fetch";
import { GET } from "./route";

describe("reader safe-fetch status mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) },
    });
  });

  it.each([
    ["SAFE_FETCH_INVALID_URL", 400],
    ["SAFE_FETCH_BODY_TOO_LARGE", 413],
    ["SAFE_FETCH_TIMEOUT", 504],
  ] as const)("returns HTTP %s truth for %s", async (code, status) => {
    mocks.safeFetch.mockRejectedValue(new SafeFetchError(code));
    const response = await GET(new NextRequest("http://axis.test/api/reader/extract?url=https%3A%2F%2Fpublic.example%2Fcanary%3Ftoken%3Dnever"));

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    if (code === "SAFE_FETCH_TIMEOUT") {
      expect(mocks.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: code }), expect.objectContaining({
        tags: expect.objectContaining({ area: "safe-fetch", operation: "reader_extract", code }),
      }));
    } else {
      expect(mocks.captureException).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("public.example");
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("token");
  });

  it("uses the shared helper to emit a sanitized timeout event", async () => {
    mocks.safeFetch.mockRejectedValue(new SafeFetchError("SAFE_FETCH_TIMEOUT"));
    await GET(new NextRequest("http://axis.test/api/reader/extract?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fprivate%3Dmust-not-leak"));

    expect(mocks.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "SAFE_FETCH_TIMEOUT" }), expect.objectContaining({
      tags: expect.objectContaining({ area: "safe-fetch", operation: "reader_extract", code: "SAFE_FETCH_TIMEOUT", provider: "youtube" }),
    }));
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("www.youtube.com");
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain("must-not-leak");
  });
});
