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
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("public.example");
    expect(JSON.stringify(mocks.addBreadcrumb.mock.calls)).not.toContain("token");
  });
});
