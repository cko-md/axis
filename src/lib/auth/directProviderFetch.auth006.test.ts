import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_PROVIDER_EXCHANGE_TIMEOUT_MS,
  directProviderExchangeFetch,
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

    const exchange = directProviderExchangeFetch(
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
});
