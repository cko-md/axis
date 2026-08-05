import http from "node:http";
import { describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { safeFetch } from "@/lib/security/safe-fetch";
import { resolveOgImage, resolveOgImageUrl } from "@/lib/og-image";

describe("OG image outbound boundary", () => {
  it("returns a direct raster's validated bytes after exactly one guarded fetch", async () => {
    const target = "https://public.example/image.png";
    const expected = new Uint8Array([137, 80, 78, 71]);
    const fetcher = vi.fn(async () => new Response(expected, {
      headers: { "content-type": "image/png; charset=binary" },
    }));

    const resolved = await resolveOgImage(target, fetcher as typeof safeFetch);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(target, expect.objectContaining({
      maxBodyBytes: 8 * 1024 * 1024,
    }));
    expect(resolved?.url).toBe(target);
    expect(resolved?.buffered?.contentType).toBe("image/png");
    expect(new Uint8Array(resolved?.buffered?.body ?? new ArrayBuffer(0))).toEqual(expected);
  });

  it("blocks a direct mapped-IPv6 image URL before its server receives a request", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => { hits += 1; res.end("not-an-image"); });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("IPv6 test server did not bind");
    try {
      await expect(resolveOgImageUrl(`http://[::ffff:127.0.0.1]:${address.port}/pixel.png?secret=never`)).resolves.toBeNull();
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("validates a discovered HTML meta image as a second hop before returning it", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => { hits += 1; res.end("INTERNAL_CANARY"); });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("IPv6 test server did not bind");
    const page = "https://public.example/article";
    const internalImage = `http://[::ffff:127.0.0.1]:${address.port}/image.png?token=never`;
    const fetcher: typeof safeFetch = async (raw, options, dependencies) => raw.toString() === page
      ? new Response(`<meta property=\"og:image\" content=\"${internalImage}\">`, {
        headers: { "content-type": "text/html" },
      })
      : safeFetch(raw, options, dependencies);
    try {
      await expect(resolveOgImageUrl(page, fetcher)).resolves.toBeNull();
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ["image/png", true], ["image/jpeg; charset=binary", true], ["image/svg+xml", false], ["text/html", false],
  ])("uses an exact inert raster media-type policy for %s", async (contentType, allowed) => {
    const result = await resolveOgImageUrl("https://public.example/unknown", async () => new Response("x", {
      headers: { "content-type": contentType },
    }));
    expect(result === "https://public.example/unknown").toBe(allowed);
  });

  it("decodes metadata entities once and validates the second-hop MIME without buffering its body", async () => {
    const page = "https://public.example/article";
    const encodedImage = "https://cdn.example/image.png?value=&amp;#38;canary";
    const seen: Array<{ url: string; bodyMode?: string }> = [];
    const result = await resolveOgImageUrl(page, async (raw, options) => {
      seen.push({ url: String(raw), bodyMode: options?.responseBodyMode });
      if (String(raw) === page) {
        return new Response(`<meta property="og:image" content="${encodedImage}">`, {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(null, { headers: { "content-type": "image/png" } });
    });

    expect(result).toBe("https://cdn.example/image.png?value=&#38;canary");
    expect(seen).toEqual([
      { url: page, bodyMode: undefined },
      { url: "https://cdn.example/image.png?value=&#38;canary", bodyMode: "discard" },
    ]);
  });
});
