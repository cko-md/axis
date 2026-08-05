import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), resolveOgImage: vi.fn(), safeFetch: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/og-image", () => ({
  isSafeRaster: vi.fn(),
  OG_IMAGE_BROWSER_HEADERS: {},
  OG_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
  OG_IMAGE_TIMEOUT_MS: 8000,
  resolveOgImage: mocks.resolveOgImage,
}));
vi.mock("@/lib/security/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));

import { GET } from "./route";

describe("OG image route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes direct image and HTML/meta inputs through the guarded resolver before returning metadata", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) } });
    mocks.resolveOgImage.mockResolvedValue(null);

    const direct = await GET(new NextRequest("http://axis.test/api/og-image?meta=1&url=https%3A%2F%2Fpublic.example%2Fimage.png"));
    const html = await GET(new NextRequest("http://axis.test/api/og-image?meta=1&url=https%3A%2F%2Fpublic.example%2Farticle"));

    expect(direct.status).toBe(200);
    expect(html.status).toBe(200);
    expect(mocks.resolveOgImage).toHaveBeenNthCalledWith(1, "https://public.example/image.png");
    expect(mocks.resolveOgImage).toHaveBeenNthCalledWith(2, "https://public.example/article");
  });

  it("reuses validated bytes for a direct raster instead of fetching the URL twice", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) } });
    mocks.resolveOgImage.mockResolvedValue({
      url: "https://public.example/image.png",
      buffered: { body: bytes.buffer, contentType: "image/png" },
    });

    const response = await GET(new NextRequest("http://axis.test/api/og-image?url=https%3A%2F%2Fpublic.example%2Fimage.png"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.resolveOgImage).toHaveBeenCalledTimes(1);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
});
