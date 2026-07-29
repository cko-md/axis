import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), resolveOgImageUrl: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/og-image", () => ({
  isSafeRaster: vi.fn(),
  OG_IMAGE_BROWSER_HEADERS: {},
  OG_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
  OG_IMAGE_TIMEOUT_MS: 8000,
  resolveOgImageUrl: mocks.resolveOgImageUrl,
}));
vi.mock("@sentry/nextjs", () => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));

import { GET } from "./route";

describe("OG image route handler", () => {
  it("routes direct image and HTML/meta inputs through the guarded resolver before returning metadata", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user" } } }) } });
    mocks.resolveOgImageUrl.mockResolvedValue(null);

    const direct = await GET(new NextRequest("http://axis.test/api/og-image?meta=1&url=https%3A%2F%2Fpublic.example%2Fimage.png"));
    const html = await GET(new NextRequest("http://axis.test/api/og-image?meta=1&url=https%3A%2F%2Fpublic.example%2Farticle"));

    expect(direct.status).toBe(200);
    expect(html.status).toBe(200);
    expect(mocks.resolveOgImageUrl).toHaveBeenNthCalledWith(1, "https://public.example/image.png");
    expect(mocks.resolveOgImageUrl).toHaveBeenNthCalledWith(2, "https://public.example/article");
  });
});
