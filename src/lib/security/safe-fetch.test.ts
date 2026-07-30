import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { resolve as resolvePath } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  isBlockedAddress,
  SafeFetchError,
  pinnedSafeFetchTransport,
  safeFetch,
  safeFetchHttpStatus,
} from "./safe-fetch";

const hasIpv6Interface = Object.values(networkInterfaces()).flat().some((address) => address?.family === "IPv6");

async function runSetupFailureChild() {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [
        resolvePath(process.cwd(), "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "src/lib/security/safe-fetch-process-child.config.ts",
        "--maxWorkers=1",
        "--no-file-parallelism",
      ], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("safe-fetch process regression child timed out"));
      }, 10_000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    },
  );
}

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

  it.each([
    "192.0.0.0",
    "192.0.0.8",
    "192.0.0.11",
    "192.0.0.169",
    "192.0.0.170",
    "192.0.0.171",
    "192.0.0.255",
    "192.88.99.0",
    "192.88.99.255",
    "198.18.0.0",
    "198.19.255.255",
  ])("classifies IPv4 IANA boundary %s as blocked", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "192.0.0.9",
    "192.0.0.10",
    "192.0.1.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.175.48.1",
    "198.17.255.255",
    "198.20.0.0",
  ])("keeps IANA globally reachable IPv4 exception %s public", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    "2001::",
    "2001:1::",
    "2001:1::4",
    "2001:1:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:2::",
    "2001:4:111:ffff:ffff:ffff:ffff:ffff",
    "2001:4:113::",
    "2001:db8::",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "2002::",
    "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "3000::1",
    "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "3fff::",
    "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
    "3fff:1000::",
    "5f00::1",
    "100:0:0:1::1",
  ])("classifies IPv6 IANA reserved boundary %s as blocked", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "64:ff9b::808:808",
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::1",
    "2001:4:112::1",
    "2001:20::1",
    "2001:30::1",
    "2001:4860:4860::8888",
    "2410::1",
    "2606:4700:4700::1111",
    "2610::1",
    "2620:4f:8000::1",
    "2630::1",
    "2a10::1",
    "2c00::1",
  ])("keeps IANA globally reachable IPv6 allocation %s public", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
  ])("applies IPv4 policy through globally reachable NAT64 address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    "::8.8.8.8",
    "::ffff:8.8.8.8",
    "::ffff:127.0.0.1",
  ])("rejects non-global IPv4-compatible/mapped IPv6 address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["192.0.0.9", "192.0.0.10", "192.0.1.1"])('permits public 192.0.x address %s', async (address) => {
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

  it.each([204, 205, 304])("treats HTTP %s as a terminal response, not a redirect", async (status) => {
    const transport = vi.fn(async () => new Response(null, {
      status,
      headers: { location: "https://169.254.169.254/latest/meta-data" },
    }));

    const response = await safeFetch("https://public.example/status", {}, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport,
    });

    expect(response.status).toBe(status);
    expect(transport).toHaveBeenCalledTimes(1);
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

  it("keeps a YouTube caption fetch on the allowed host across a hostile redirect", async () => {
    const transport = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/caption?token=never" },
    }));

    await expect(safeFetch("https://www.youtube.com/api/timedtext?fmt=json3", {
      allowedHosts: ["www.youtube.com"],
    }, {
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

  it("honors caller abort while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    const transport = vi.fn();
    const operation = safeFetch("https://slow.example", {
      timeoutMs: 1_000,
      signal: controller.signal,
    }, {
      resolve: async () => new Promise(() => undefined),
      transport,
    });

    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: "SAFE_FETCH_ABORTED" });
    expect(transport).not.toHaveBeenCalled();
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

  it.skipIf(!hasIpv6Interface)("pins a public hostname to an IPv6 socket without a second DNS lookup", async () => {
    let requestHost = "";
    let socketAddress = "";
    const server = http.createServer((req, res) => {
      requestHost = req.headers.host ?? "";
      socketAddress = req.socket.remoteAddress ?? "";
      res.end("IPV6_PINNED");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("IPv6 test server did not bind");

      // The original hostname is intentionally unresolvable. The old
      // `URL.hostname = "::1"` transport leaves it in place, so it cannot
      // reach this server. A pinned request must use ::1 directly while
      // preserving the original Host header for virtual-host correctness.
      const response = await pinnedSafeFetchTransport(new URL(`http://safe-fetch.invalid:${address.port}/ipv6`), {
        headers: undefined,
        timeoutMs: 500,
        maxBodyBytes: 32,
        address: { address: "::1", family: 6 },
      });

      expect(await response.text()).toBe("IPV6_PINNED");
      expect(requestHost).toBe(`safe-fetch.invalid:${address.port}`);
      expect(socketAddress).toBe("::1");
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
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

  it.each([204, 205, 304])("constructs a no-body Response for production transport status %s", async (status) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const response = await pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/status`), {
        headers: undefined, timeoutMs: 500, maxBodyBytes: 32, address: { address: "127.0.0.1", family: 4 },
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds an invalid upstream status as a typed production transport failure", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(600);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const request = pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/invalid-status`), {
        headers: undefined, timeoutMs: 500, maxBodyBytes: 32, address: { address: "127.0.0.1", family: 4 },
      });
      await expect(Promise.race([
        request,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("transport did not settle")), 200)),
      ])).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds Response construction failures from the production transport", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const NativeResponse = globalThis.Response;
    try {
      vi.stubGlobal("Response", class {
        constructor() {
          throw new TypeError("forced response/header construction failure");
        }
      });
      await expect(pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/forced-construction-error`), {
        headers: undefined, timeoutMs: 500, maxBodyBytes: 32, address: { address: "127.0.0.1", family: 4 },
      })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
    } finally {
      vi.stubGlobal("Response", NativeResponse);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("normalizes invalid direct and safeFetch headers as typed transport failures", async () => {
    await expect(pinnedSafeFetchTransport(new URL("http://localhost:9/direct-invalid-header"), {
      headers: { accept: "invalid\nvalue" },
      timeoutMs: 100,
      maxBodyBytes: 32,
      address: { address: "127.0.0.1", family: 4 },
    })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });

    await expect(safeFetch("http://public.example/safe-fetch-invalid-header", {
      headers: { accept: "invalid\nvalue" },
    }, {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
  });

  it("normalizes a setup failure after ClientRequest construction", async () => {
    await expect(pinnedSafeFetchTransport(new URL("http://localhost:9/invalid-setup-option"), {
      headers: undefined,
      timeoutMs: -1,
      maxBodyBytes: 32,
      address: { address: "127.0.0.1", family: 4 },
    })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
  });

  it("contains setup failures after ClientRequest construction without a late process crash", async () => {
    const result = await runSetupFailureChild();
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain("SAFE_FETCH_PROCESS_CHILD_OK");
    expect(result.stderr).not.toContain("uncaughtException");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  }, 10_000);

  it("aborts an active production socket, closes the peer, and never later resolves", async () => {
    let peerClosed = false;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const server = http.createServer((_req, res) => {
      res.on("close", () => { peerClosed = true; });
      res.write("partial");
      requestStarted();
      setTimeout(() => res.end("late"), 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const controller = new AbortController();
    try {
      const request = pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/abort`), {
        headers: undefined, timeoutMs: 500, maxBodyBytes: 32, address: { address: "127.0.0.1", family: 4 }, signal: controller.signal,
      });
      await started;
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: "SAFE_FETCH_ABORTED" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(peerClosed).toBe(true);
      await expect(Promise.race([
        request.then(() => "resolved", () => "rejected"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
      ])).resolves.toBe("rejected");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("decodes supported content encodings with independent wire and decoded caps", async () => {
    let acceptEncoding = "";
    const plain = Buffer.from("plaintext");
    const server = http.createServer((req, res) => {
      acceptEncoding = req.headers["accept-encoding"] ?? "";
      if (req.url === "/gzip") return void res.writeHead(200, { "content-encoding": "gzip", "content-length": gzipSync(plain).length }).end(gzipSync(plain));
      if (req.url === "/deflate") return void res.writeHead(200, { "content-encoding": "deflate" }).end(deflateSync(plain));
      if (req.url === "/br") return void res.writeHead(200, { "content-encoding": "br" }).end(brotliCompressSync(plain));
      if (req.url === "/bomb") return void res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(5, "x")));
      if (req.url === "/raw-over") return void res.end("12345");
      if (req.url === "/invalid") return void res.writeHead(200, { "content-encoding": "gzip" }).end("not-gzip");
      if (req.url === "/unsupported") return void res.writeHead(200, { "content-encoding": "zstd" }).end("ignored");
      if (req.url === "/stall") return void setTimeout(() => res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(plain)), 100);
      res.end(plain);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const input = { headers: undefined as HeadersInit | undefined, timeoutMs: 500, maxBodyBytes: 4_096, address: { address: "127.0.0.1", family: 4 } };
    const fetchPath = (path: string, overrides: Partial<typeof input> = {}) => pinnedSafeFetchTransport(
      new URL(`http://localhost:${address.port}${path}`), { ...input, ...overrides },
    );
    try {
      for (const path of ["/plain", "/gzip", "/deflate", "/br"]) {
        const response = await fetchPath(path);
        expect(await response.text()).toBe("plaintext");
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("content-length")).toBeNull();
      }
      expect(acceptEncoding).toBe("identity");
      await expect(fetchPath("/bomb", { maxBodyBytes: 4 })).rejects.toMatchObject({ code: "SAFE_FETCH_BODY_TOO_LARGE" });
      await expect(fetchPath("/raw-over", { maxBodyBytes: 4 })).rejects.toMatchObject({ code: "SAFE_FETCH_BODY_TOO_LARGE" });
      await expect(fetchPath("/invalid")).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
      await expect(fetchPath("/unsupported")).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
      await expect(fetchPath("/stall", { timeoutMs: 10 })).rejects.toMatchObject({ code: "SAFE_FETCH_TIMEOUT" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
