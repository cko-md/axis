import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseVectorJsonBody } from "@/lib/vector/server";

const schema = z.object({ value: z.string() }).strict();

describe("VECTOR server request boundary", () => {
  it("requires JSON and rejects unknown fields", async () => {
    await expect(parseVectorJsonBody(new Request("http://axis.test", {
      method: "POST",
      body: "{}",
    }), schema)).resolves.toMatchObject({
      ok: false,
      status: 415,
      code: "VECTOR_JSON_REQUIRED",
    });
    await expect(parseVectorJsonBody(new Request("http://axis.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "ok", ownerId: "forbidden" }),
    }), schema)).resolves.toMatchObject({
      ok: false,
      status: 400,
      code: "VECTOR_INVALID_BODY",
    });
  });

  it("enforces both declared and actual UTF-8 body limits", async () => {
    await expect(parseVectorJsonBody(new Request("http://axis.test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "100",
      },
      body: JSON.stringify({ value: "ok" }),
    }), schema, 10)).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
    await expect(parseVectorJsonBody(new Request("http://axis.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "éééé" }),
    }), schema, 16)).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it("cancels a chunked request as soon as the byte limit is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("12345678"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://axis.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(parseVectorJsonBody(request, schema, 10)).resolves.toMatchObject({
      ok: false,
      status: 413,
      code: "VECTOR_SYNC_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });
});
