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

import { SafeFetchError } from "@/lib/security/safe-fetch";
import { GET } from "./route";

describe("web proxy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) },
    });
  });

  it("preserves safe-fetch timeout truth instead of returning a silent 200 fallback", async () => {
    mocks.safeFetch.mockRejectedValue(new SafeFetchError("SAFE_FETCH_TIMEOUT"));
    const response = await GET(new NextRequest("http://axis.test/api/proxy?url=https%3A%2F%2Fpublic.example%2Fslow"));

    expect(response.status).toBe(504);
    expect(response.headers.get("x-axis-proxy-error")).toBe("SAFE_FETCH_TIMEOUT");
    expect(await response.text()).toContain("Could not load page safely");
  });

  it("injects a base derived from the final validated redirect URL", async () => {
    const upstream = new Response("<html><head></head><body>ok</body></html>", {
      headers: { "content-type": "text/html" },
    });
    Object.defineProperty(upstream, "url", { value: "https://cdn.example/final/path/" });
    mocks.safeFetch.mockResolvedValue(upstream);

    const response = await GET(new NextRequest("http://axis.test/api/proxy?url=https%3A%2F%2Fpublic.example%2Foriginal"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<base href="https://cdn.example/final/path/">');
    expect(html).not.toContain('<base href="https://public.example/original">');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).not.toContain("allow-same-origin");
  });
});
