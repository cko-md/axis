import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_PROVIDER_EXCHANGE_MAX_BYTES,
  DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS,
  DirectProviderResponseTooLargeError,
  directProviderExchangeJson,
} from "@/lib/auth/directProviderFetch.server";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AUTH-006 bounded provider exchanges", () => {
  it("aborts a hung no-store exchange at the fixed boundary", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const providerFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Timed out", "AbortError"));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", providerFetch);

    const exchange = directProviderExchangeJson(
      "https://accounts.spotify.com/api/token",
      { method: "POST" },
    );
    const rejection = expect(exchange).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS);

    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(providerFetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      cache: "no-store",
    });
  });

  it.each([true, false])(
    "keeps the deadline active through a stalled response body (ok=%s)",
    async (ok) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(new Response(new ReadableStream({
          start: () => undefined,
        }), { status: ok ? 200 : 400 }));
      }));

      const exchange = directProviderExchangeJson(
        "https://www.strava.com/oauth/token",
        { method: "POST" },
      );
      const rejection = expect(exchange).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS);

      await rejection;
      expect(signal?.aborted).toBe(true);
    },
  );

  it("rejects and cancels an advertised oversized response before reading", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream({ cancel }),
      {
        status: 400,
        headers: {
          "Content-Length": String(DIRECT_PROVIDER_EXCHANGE_MAX_BYTES + 1),
        },
      },
    )));

    await expect(directProviderExchangeJson(
      "https://accounts.spotify.com/api/token",
      { method: "POST" },
    )).rejects.toBeInstanceOf(DirectProviderResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects and cancels a chunked response that crosses the byte ceiling", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(DIRECT_PROVIDER_EXCHANGE_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }),
      { status: 400 },
    )));

    await expect(directProviderExchangeJson(
      "https://www.strava.com/oauth/token",
      { method: "POST" },
    )).rejects.toBeInstanceOf(DirectProviderResponseTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
