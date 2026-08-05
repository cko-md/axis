import { describe, expect, it } from "vitest";
import http from "node:http";
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
});
