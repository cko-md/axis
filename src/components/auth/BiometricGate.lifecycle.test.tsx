// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  fetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));
vi.mock("@/hooks/usePasskey", () => ({
  usePasskey: () => ({ isSupported: false, register: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("./BiometricPrompt", () => ({
  default: () => "biometric prompt",
}));

import BiometricGate from "./BiometricGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type SettingsResponse = Pick<Response, "json" | "ok" | "status">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function promptedResponse(biometricPrompted: boolean): SettingsResponse {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ biometric_prompted: biometricPrompted }),
  };
}

function persistedPageShow() {
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: true });
  return event;
}

async function flushFailureCommit() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

let root: Root | null;

beforeEach(() => {
  mocks.captureException.mockReset();
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("BiometricGate lookup lifecycle", () => {
  it("still captures an identical live network failure once", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("same live-looking failure"));

    act(() => root?.render(<BiometricGate />));
    await act(flushFailureCommit);

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("aborts and consumes a TypeError that races with pagehide", async () => {
    const lookup = deferred<never>();
    mocks.fetch.mockReturnValueOnce(lookup.promise);

    act(() => root?.render(<BiometricGate />));
    const request = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    act(() => window.dispatchEvent(new Event("pagehide")));

    expect(request.signal?.aborted).toBe(true);
    lookup.reject(new TypeError("same live-looking failure"));
    await act(flushFailureCommit);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("drops a delayed response body after pagehide", async () => {
    const body = deferred<unknown>();
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(() => body.promise),
    } satisfies SettingsResponse);

    act(() => root?.render(<BiometricGate />));
    await act(async () => { await Promise.resolve(); });
    act(() => window.dispatchEvent(new Event("pagehide")));
    body.resolve({});
    await act(flushFailureCommit);

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each([
    ["already prompted", () => promptedResponse(true)],
    ["signed out", () => ({ ok: false, status: 401, json: vi.fn() } satisfies SettingsResponse)],
    ["MFA deferred", () => ({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({
        error: "MFA_REQUIRED",
        message: "Complete two-factor authentication to continue.",
      }),
    } satisfies SettingsResponse)],
  ])("clears a pre-BFCache prompt when restored state is %s", async (_case, restoredResponse) => {
    mocks.fetch
      .mockResolvedValueOnce(promptedResponse(false))
      .mockResolvedValueOnce(restoredResponse());

    act(() => root?.render(<BiometricGate />));
    await act(flushFailureCommit);
    expect(document.body.textContent).toContain("biometric prompt");

    act(() => window.dispatchEvent(new Event("pagehide")));
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("biometric prompt");

    act(() => window.dispatchEvent(persistedPageShow()));
    await act(flushFailureCommit);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("biometric prompt");
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
