import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { SafeFetchError, pinnedSafeFetchTransport, safeFetch, safeFetchHttpStatus } from "./safe-fetch";

describe("safeFetch", () => {
  it("refuses a DNS-resolved loopback target before the transport is invoked", async () => {
    const transport = vi.fn();

    await expect(
      safeFetch("https://public.example/article", {}, {
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        transport,
      }),
    ).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });

    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a redirect to an internal target before requesting its next hop", async () => {
    const transport = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(
      safeFetch("https://public.example/article", {}, {
        resolve: async (hostname) => hostname === "public.example"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }],
        transport,
      }),
    ).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "2002:7f00:1::",
    "2001::1",
    "100::1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "192.0.2.1",
    "198.51.100.2",
    "203.0.113.3",
  ])("rejects reserved address %s before transport", async (address) => {
    const transport = vi.fn();

    await expect(
      safeFetch("https://public.example/article", {}, {
        resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        transport,
      }),
    ).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });

    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["192.0.0.9", "192.0.1.1"])('permits public 192.0.x address %s', async (address) => {
    const transport = vi.fn(async () => new Response("ok"));
    await expect(safeFetch("https://public.example/article", {}, {
      resolve: async () => [{ address, family: 4 }],
      transport,
    })).resolves.toBeInstanceOf(Response);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SAFE_FETCH_INVALID_URL", 400],
    ["SAFE_FETCH_BLOCKED_ADDRESS", 403],
    ["SAFE_FETCH_BODY_TOO_LARGE", 413],
    ["SAFE_FETCH_TIMEOUT", 504],
    ["SAFE_FETCH_TRANSPORT_FAILED", 502],
  ] as const)("maps %s to HTTP %s", (code, status) => {
    expect(safeFetchHttpStatus(new SafeFetchError(code))).toBe(status);
  });

  it("preserves a validated final URL after a bounded public redirect", async () => {
    const transport = vi.fn(async (url: URL) => url.hostname === "public.example"
      ? new Response(null, { status: 302, headers: { location: "https://cdn.example/article" } })
      : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));

    const response = await safeFetch("https://public.example/article", {}, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    });

    expect(response.url).toBe("https://cdn.example/article");
    expect(await response.text()).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("pins the connection to the validated resolver result and strips credentials", async () => {
    const transport = vi.fn(async (...args: [URL, unknown]) => {
      expect(args[0].hostname).toBe("public.example");
      return new Response("ok");
    });
    await safeFetch("https://public.example/article", {
      headers: { authorization: "Bearer private", cookie: "session=private", "x-trace": "allowed" },
    }, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    });

    const input = transport.mock.calls[0]?.[1] as { address: { address: string; family: number }; headers: Headers };
    expect(input).toMatchObject({ address: { address: "93.184.216.34", family: 4 } });
    const headers = input.headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-trace")).toBeNull();
  });

  it("denies mixed public/private DNS answers rather than choosing the public address", async () => {
    const transport = vi.fn();
    await expect(safeFetch("https://mixed.example", {}, {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
      transport,
    })).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes a trailing dot before host policy and never invokes transport", async () => {
    const transport = vi.fn();
    await expect(safeFetch("https://accounts.google.com./authorize", {}, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    })).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_HOST" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("enforces an exact allowed-host policy on every redirect hop", async () => {
    const transport = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://cdn.example/redirected" },
    }));
    await expect(safeFetch("https://www.youtube.com/watch", { allowedHosts: ["www.youtube.com"] }, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    })).rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_HOST" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("enforces the total deadline while DNS is still pending", async () => {
    await expect(safeFetch("https://slow.example", { timeoutMs: 10 }, {
      resolve: async () => new Promise(() => undefined),
    })).rejects.toMatchObject({ code: "SAFE_FETCH_TIMEOUT" });
  });

  it("rejects an oversized declared body before any consumer can read it", async () => {
    await expect(safeFetch("https://public.example/file", { maxBodyBytes: 4 }, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => new Response("anything", { headers: { "content-length": "5" } }),
    })).rejects.toMatchObject({ code: "SAFE_FETCH_BODY_TOO_LARGE" });
  });

  it("never opens a real socket to a hex-mapped IPv6 loopback address", async () => {
    let internalHits = 0;
    const server = http.createServer((_req, res) => {
      internalHits += 1;
      res.end("INTERNAL_CANARY");
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("IPv6 test server did not bind");
    try {
      await expect(safeFetch(`http://[::ffff:127.0.0.1]:${address.port}/canary`))
        .rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });
      expect(internalHits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("enforces declared size, exact cap, and cap+1 cancellation with the production transport", async () => {
    let overCapConnectionClosed = false;
    const server = http.createServer((req, res) => {
      if (req.url === "/declared") {
        res.writeHead(200, { "content-length": "5" });
        return void res.end("12345");
      }
      if (req.url === "/exact") {
        res.writeHead(200, { "content-length": "4" });
        return void res.end("1234");
      }
      // No Content-Length: the cap must be enforced while bytes stream and
      // must tear down the peer connection as soon as the fifth byte arrives.
      res.on("close", () => { overCapConnectionClosed = true; });
      res.write("1234");
      setTimeout(() => res.write("5"), 10);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const input = { headers: undefined, timeoutMs: 500, maxBodyBytes: 4, address: { address: "127.0.0.1", family: 4 } } as const;
    try {
      const exact = await pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/exact`), input);
      expect(await exact.text()).toBe("1234");
      await expect(pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/declared`), input))
        .rejects.toMatchObject({ code: "SAFE_FETCH_BODY_TOO_LARGE" });
      await expect(pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/over`), input))
        .rejects.toMatchObject({ code: "SAFE_FETCH_BODY_TOO_LARGE" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(overCapConnectionClosed).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses a total deadline even when a peer dribbles response bytes", async () => {
    const server = http.createServer((_req, res) => {
      res.write("a");
      setTimeout(() => res.write("b"), 25);
      setTimeout(() => res.end("c"), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      await expect(pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/dribble`), {
        headers: undefined, timeoutMs: 30, maxBodyBytes: 32, address: { address: "127.0.0.1", family: 4 },
      })).rejects.toMatchObject({ code: "SAFE_FETCH_TIMEOUT" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
