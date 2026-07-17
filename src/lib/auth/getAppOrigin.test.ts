import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { buildAppUrl, getAppOrigin } from "./getAppOrigin";

// Next.js's NextURL rewrites 127.0.0.1/[::1] to the literal string "localhost"
// inside req.nextUrl regardless of what's passed to the URL — the request URL
// argument here is deliberately always the (post-rewrite) localhost form; the
// `host` header is the only channel that preserves what the client actually
// sent, so it's what getAppOrigin must — and does — read.
function request(url: string, host: string): NextRequest {
  return new NextRequest(url, { headers: { host } });
}

describe("getAppOrigin()", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  });

  it("uses the configured origin for non-loopback requests (production)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis.example.com/";
    expect(
      getAppOrigin(request("https://axis.example.com/api/spotify/auth", "axis.example.com")),
    ).toBe("https://axis.example.com");
  });

  // Regression: OAuth providers require an exact redirect_uri match, and some
  // (Spotify) only exempt the literal loopback IP 127.0.0.1 from HTTPS — not
  // the hostname "localhost". A single hardcoded NEXT_PUBLIC_APP_URL can only
  // match one of the two, so it must defer to whatever the browser actually
  // used (read from the raw Host header — req.nextUrl can't be trusted here,
  // see the comment in getAppOrigin.ts) for loopback requests.
  it("trusts the raw Host header for localhost, even when a different value is configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3200";
    expect(
      getAppOrigin(request("http://localhost:3200/api/spotify/auth", "localhost:3200")),
    ).toBe("http://localhost:3200");
  });

  it("trusts the raw Host header for 127.0.0.1, even when a different value is configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3200";
    expect(
      getAppOrigin(request("http://localhost:3200/api/spotify/auth", "127.0.0.1:3200")),
    ).toBe("http://127.0.0.1:3200");
  });

  it("trusts a raw loopback Host even when no app origin is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      getAppOrigin(request("http://localhost:3200/vector", "127.0.0.1:3200")),
    ).toBe("http://127.0.0.1:3200");
  });

  it("falls back to the request origin when nothing is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      getAppOrigin(request("https://axis.example.com/api/strava", "axis.example.com")),
    ).toBe("https://axis.example.com");
  });

  it("preserves the raw loopback host when nothing is configured", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      getAppOrigin(request("http://localhost:3200/api/strava", "127.0.0.1:3200")),
    ).toBe("http://127.0.0.1:3200");
  });

  it("does not use the Host header override for a non-loopback host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis.example.com";
    expect(
      getAppOrigin(request("https://evil.example.com/api/spotify/auth", "evil.example.com")),
    ).toBe("https://axis.example.com");
  });

  it("keeps same-app redirects on a preview request instead of the configured production origin", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis.example.com";
    expect(
      buildAppUrl(
        request("https://axis-preview.vercel.app/command", "axis-preview.vercel.app"),
        "/login?redirect=%2Fcommand",
      ).toString(),
    ).toBe("https://axis-preview.vercel.app/login?redirect=%2Fcommand");
  });

  it("keeps same-app loopback redirects on the raw request host", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      buildAppUrl(
        request("http://localhost:3200/command", "127.0.0.1:3200"),
        "/login?redirect=%2Fcommand",
      ).toString(),
    ).toBe("http://127.0.0.1:3200/login?redirect=%2Fcommand");
  });

  it("rejects crafted Host values that only begin with a loopback hostname", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis.example.com";
    const crafted = request(
      "https://axis-preview.vercel.app/command",
      "127.0.0.1:443@evil.example.com",
    );

    expect(getAppOrigin(crafted)).toBe("https://axis.example.com");
    expect(buildAppUrl(crafted, "/login").toString()).toBe(
      "https://axis-preview.vercel.app/login",
    );
  });
});
