import http from "node:http";
import { describe, expect, it } from "vitest";
import { fetchAndParse } from "./rss";

describe("fetchAndParse", () => {
  it("does not connect to a mapped-IPv6 loopback feed canary", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end("<rss><channel><title>canary</title></channel></rss>");
    });
    await new Promise<void>((resolve) => server.listen(0, "::", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("IPv6 test server did not bind");
    try {
      await expect(fetchAndParse(`http://[::ffff:127.0.0.1]:${address.port}/feed?body=must-not-leak`))
        .rejects.toMatchObject({ code: "SAFE_FETCH_BLOCKED_ADDRESS" });
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
