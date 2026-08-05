import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { resolve as resolvePath } from "node:path";
import { pinnedSafeFetchTransport, safeFetch } from "./safe-fetch";

describe("safe-fetch setup failure process containment", () => {
  it("survives invalid headers and a late request error after invalid setup options", async () => {
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

    await expect(pinnedSafeFetchTransport(new URL("http://localhost:9/late-error"), {
      headers: undefined,
      timeoutMs: -1,
      maxBodyBytes: 32,
      address: { address: "127.0.0.1", family: 4 },
    })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });

    // The invalid setTimeout call happens after ClientRequest construction.
    // Leave the process alive long enough for a later socket error to prove it
    // is observed by the already-attached listener rather than going uncaught.
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stdout.write("SAFE_FETCH_PROCESS_CHILD_OK\n");
  });

  it("contains malformed decompression errors without a late process crash", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end("not-gzip");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      await expect(pinnedSafeFetchTransport(new URL(`http://localhost:${address.port}/invalid-gzip`), {
        headers: undefined,
        timeoutMs: 500,
        maxBodyBytes: 32,
        address: { address: "127.0.0.1", family: 4 },
      })).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("pins HTTP and HTTPS despite hostile process proxy and TLS settings", async () => {
    let httpHits = 0;
    let httpsHits = 0;
    let httpHost = "";
    let httpsHost = "";
    let tlsServername = "";
    const httpServer = http.createServer((request, response) => {
      httpHits += 1;
      httpHost = request.headers.host ?? "";
      response.end("HTTP_PINNED");
    });
    const httpsServer = https.createServer({
      key: readFileSync(resolvePath(process.cwd(), "src/lib/security/fixtures/safe-fetch-test-server-key.fixture")),
      cert: readFileSync(resolvePath(process.cwd(), "src/lib/security/fixtures/safe-fetch-test-server.fixture")),
    }, (request, response) => {
      httpsHits += 1;
      httpsHost = request.headers.host ?? "";
      response.end("HTTPS_PINNED");
    });
    httpsServer.on("secureConnection", (socket) => {
      tlsServername = typeof socket.servername === "string" ? socket.servername : "";
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(0, "127.0.0.1", resolve);
      }),
      new Promise<void>((resolve, reject) => {
        httpsServer.once("error", reject);
        httpsServer.listen(0, "127.0.0.1", resolve);
      }),
    ]);
    const httpAddress = httpServer.address();
    const httpsAddress = httpsServer.address();
    if (!httpAddress || typeof httpAddress === "string" || !httpsAddress || typeof httpsAddress === "string") {
      throw new Error("hostile-environment target servers did not bind");
    }
    try {
      const httpResponse = await pinnedSafeFetchTransport(
        new URL(`http://safe-fetch.invalid:${httpAddress.port}/http-pinned`),
        {
          headers: undefined,
          timeoutMs: 500,
          maxBodyBytes: 32,
          address: { address: "127.0.0.1", family: 4 },
        },
      );
      const httpsResponse = await pinnedSafeFetchTransport(
        new URL(`https://safe-fetch.invalid:${httpsAddress.port}/https-pinned`),
        {
          headers: undefined,
          timeoutMs: 500,
          maxBodyBytes: 32,
          address: { address: "127.0.0.1", family: 4 },
        },
      );
      await expect(pinnedSafeFetchTransport(
        new URL(`https://wrong-safe-fetch.invalid:${httpsAddress.port}/wrong-san`),
        {
          headers: undefined,
          timeoutMs: 500,
          maxBodyBytes: 32,
          address: { address: "127.0.0.1", family: 4 },
        },
      )).rejects.toMatchObject({ code: "SAFE_FETCH_TRANSPORT_FAILED" });

      expect(await httpResponse.text()).toBe("HTTP_PINNED");
      expect(await httpsResponse.text()).toBe("HTTPS_PINNED");
      expect(httpHits).toBe(1);
      expect(httpHost).toBe(`safe-fetch.invalid:${httpAddress.port}`);
      expect(httpsHost).toBe(`safe-fetch.invalid:${httpsAddress.port}`);
      expect(tlsServername).toBe("safe-fetch.invalid");
      // The failed wrong-SAN handshake must never reach the HTTP handler, even
      // though this child starts with NODE_TLS_REJECT_UNAUTHORIZED=0.
      expect(httpsHits).toBe(1);
      process.stdout.write("SAFE_FETCH_HOSTILE_ENV_OK\n");
      process.stdout.write("SAFE_FETCH_WRONG_SAN_REJECTED\n");
    } finally {
      await Promise.all([
        new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => httpsServer.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });
});
