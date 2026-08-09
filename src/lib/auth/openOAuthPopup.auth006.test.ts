// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDirectOAuthPopup } from "@/lib/auth/openOAuthPopup";
import { EXPECTED_PROFILE_SUBJECT_HEADER } from "@/lib/auth/profileSubject";

const SUBJECT = `ps1_${"b".repeat(64)}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakePopup() {
  const popup = {
    closed: false,
    close: vi.fn(() => { popup.closed = true; }),
    location: { replace: vi.fn() },
  };
  return popup;
}

describe("direct OAuth popup AUTH-006 lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens synchronously, initiates by subject-bound POST, and navigates the exact popup", async () => {
    const popup = fakePopup();
    const response = deferred<Response>();
    const order: string[] = [];
    vi.spyOn(window, "open").mockImplementation(() => {
      order.push("open");
      return popup as unknown as Window;
    });
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => {
      order.push("fetch");
      return response.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    openDirectOAuthPopup({
      provider: "spotify",
      subject: SUBJECT,
      epoch: 7,
      isCurrent: () => true,
      onDone: vi.fn(),
    });

    expect(order).toEqual(["open", "fetch"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url.toString(), window.location.origin).pathname).toBe("/api/spotify/auth");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get(EXPECTED_PROFILE_SUBJECT_HEADER)).toBe(SUBJECT);

    response.resolve(new Response(JSON.stringify({
      url: "https://accounts.spotify.com/authorize?state=nonce-only",
    }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.replace).toHaveBeenCalledWith(
      "https://accounts.spotify.com/authorize?state=nonce-only",
    );
  });

  it("accepts exactly one current completion from the exact origin, source, and provider", async () => {
    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      url: "https://www.strava.com/oauth/authorize?state=random",
    }), { status: 200 })));
    const onDone = vi.fn();

    openDirectOAuthPopup({
      provider: "strava",
      subject: SUBJECT,
      epoch: 9,
      isCurrent: () => true,
      onDone,
    });
    await Promise.resolve();
    await Promise.resolve();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.example",
      source: popup as unknown as Window,
      data: { type: "oauth-done", provider: "strava", status: "ok" },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: { type: "oauth-done", provider: "strava", status: "ok" },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: popup as unknown as Window,
      data: { type: "oauth-done", provider: "spotify", status: "ok" },
    }));
    expect(onDone).not.toHaveBeenCalled();

    const valid = new MessageEvent("message", {
      origin: window.location.origin,
      source: popup as unknown as Window,
      data: { type: "oauth-done", provider: "strava", status: "ok" },
    });
    window.dispatchEvent(valid);
    window.dispatchEvent(valid);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("strava", "ok", undefined);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("aborts initiation and retires without feedback when authority is cancelled", async () => {
    const popup = fakePopup();
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return response.promise;
    }));
    const onDone = vi.fn();
    let current = true;

    const handle = openDirectOAuthPopup({
      provider: "spotify",
      subject: SUBJECT,
      epoch: 1,
      isCurrent: () => current,
      onDone,
    });
    current = false;
    handle.cancel();
    expect(signal?.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({
      url: "https://accounts.spotify.com/authorize?state=late",
    }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it("suppresses feedback when a same-authority replacement cancels the prior initiation", async () => {
    const firstPopup = fakePopup();
    const secondPopup = fakePopup();
    vi.spyOn(window, "open")
      .mockReturnValueOnce(firstPopup as unknown as Window)
      .mockReturnValueOnce(secondPopup as unknown as Window);
    const secondResponse = deferred<Response>();
    let call = 0;
    vi.stubGlobal("fetch", vi.fn((_url: URL, init?: RequestInit) => {
      call += 1;
      if (call === 2) return secondResponse.promise;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Replaced", "AbortError"));
        }, { once: true });
      });
    }));
    const firstDone = vi.fn();
    const secondDone = vi.fn();
    const first = openDirectOAuthPopup({
      provider: "spotify",
      subject: SUBJECT,
      epoch: 3,
      isCurrent: () => true,
      onDone: firstDone,
    });
    first.cancel();
    openDirectOAuthPopup({
      provider: "spotify",
      subject: SUBJECT,
      epoch: 3,
      isCurrent: () => true,
      onDone: secondDone,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(firstDone).not.toHaveBeenCalled();
    expect(firstPopup.close).toHaveBeenCalledTimes(1);
    expect(secondPopup.close).not.toHaveBeenCalled();

    secondResponse.resolve(new Response(JSON.stringify({
      url: "https://accounts.spotify.com/authorize?state=replacement",
    }), { status: 200 }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(secondPopup.location.replace).toHaveBeenCalledWith(
      "https://accounts.spotify.com/authorize?state=replacement",
    );
    expect(secondDone).not.toHaveBeenCalled();
  });
});
