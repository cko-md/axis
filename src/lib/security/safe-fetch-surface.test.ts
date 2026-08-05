import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const surfaces = [
  "src/app/api/reader/extract/route.ts",
  "src/app/api/proxy/route.ts",
  "src/app/api/og-image/route.ts",
  "src/lib/feeds/rss.ts",
  "src/app/api/notes/youtube/route.ts",
];

describe("untrusted outbound fetch surfaces", () => {
  it.each(surfaces)("routes %s through safeFetch rather than direct fetch", async (file) => {
    const source = await readFile(path.join(root, file), "utf8");
    expect(source).toMatch(/safeFetch/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/redirect:\s*["']follow/);
  });

  it("keeps proxy HTML sandboxed, proxies only raster images, and never reflects raw errors", async () => {
    const source = await readFile(path.join(root, "src/app/api/proxy/route.ts"), "utf8");
    expect(source).toMatch(/Content-Security-Policy/);
    expect(source).toMatch(/sandbox allow-scripts/);
    expect(source).not.toMatch(/allow-same-origin/);
    expect(source).toMatch(/SAFE_RASTER_TYPES/);
    expect(source).not.toMatch(/err\.message/);
  });

  it("allows only raster previews and constrains every caption hop to YouTube", async () => {
    const image = await readFile(path.join(root, "src/lib/og-image.ts"), "utf8");
    const youtube = await readFile(path.join(root, "src/app/api/notes/youtube/route.ts"), "utf8");
    expect(image).toMatch(/SAFE_RASTER_TYPES/);
    expect(image).toMatch(/const imageResponse = await fetcher/);
    expect(youtube).toMatch(/captionUrl\.hostname !== "www\.youtube\.com"/);
    expect(youtube).toMatch(/allowedHosts: \["www\.youtube\.com"\]/);
  });

  it("pins each connection to its checked DNS address without rewriting IPv6 URL hostnames", async () => {
    const source = await readFile(path.join(root, "src/lib/security/safe-fetch.ts"), "utf8");
    expect(source).toMatch(/hostname: input\.address\.address/);
    expect(source).toMatch(/family: input\.address\.family/);
    expect(source).not.toMatch(/pinnedUrl\.hostname = pinnedAddress/);
    expect(source).toMatch(/const tlsIdentity = bareHost\(url\.hostname\)/);
    expect(source).toMatch(/options\.servername = tlsIdentity/);
    expect(source).toMatch(/redirects <= maxRedirects/);
  });

  it("keeps every runtime route off the deprecated ssrf compatibility preflight", async () => {
    const apiRoot = path.join(root, "src/app/api");
    const files = await readdir(apiRoot, { recursive: true });
    const routeFiles = files.filter((file) => file.endsWith("route.ts"));
    for (const file of routeFiles) {
      const source = await readFile(path.join(apiRoot, file), "utf8");
      expect(source).not.toMatch(/from\s+["'][^"']*security\/ssrf["']/);
      expect(source).not.toMatch(/import\(\s*["'][^"']*security\/ssrf["']\s*\)/);
    }
  });
});
