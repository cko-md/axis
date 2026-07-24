import { describe, expect, it, vi } from "vitest";
import { readBoundedJsonBody } from "./readBoundedJsonBody";

describe("readBoundedJsonBody", () => {
  it("accepts one bounded plain object", async () => {
    const request = new Request("http://axis.test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    });
    await expect(readBoundedJsonBody(request, 128)).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it("rejects a chunked body that exceeds the cap without Content-Length", async () => {
    const request = new Request("http://axis.test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new TextEncoder().encode("x".repeat(256)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedJsonBody(request, 32)).resolves.toMatchObject({
      ok: false,
      error: "BODY_TOO_LARGE",
      status: 413,
    });
  });

  it("cancels a slow body at the absolute deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const request = new Request("http://axis.test", {
      method: "POST",
      body: new ReadableStream({
        pull() {
          return new Promise(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      }),
      duplex: "half",
    } as RequestInit);
    const pending = readBoundedJsonBody(request, 128, 50);
    await vi.advanceTimersByTimeAsync(51);
    await expect(pending).resolves.toMatchObject({ ok: false, error: "INVALID_BODY" });
    expect(cancelled).toBe(true);
    vi.useRealTimers();
  });
});
