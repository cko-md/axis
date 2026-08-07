// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  fetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.capture }));
vi.mock("@/hooks/usePasskey", () => ({
  usePasskey: () => ({ isSupported: false, register: vi.fn() }),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("./BiometricPrompt", () => ({ default: () => <span>prompt</span> }));

import BiometricGate from "./BiometricGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let root: Root | null;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.capture.mockReset();
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

describe("BiometricGate navigation failure commit", () => {
  it("drops a settings rejection delivered before the following pagehide macrotask", async () => {
    let rejectLookup!: (reason: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectLookup = reject;
    }));

    act(() => root?.render(<BiometricGate />));
    await act(flushMicrotasks);

    await act(async () => {
      rejectLookup(new Error("navigation interrupted the settings fetch"));
      await flushMicrotasks();
      window.dispatchEvent(new Event("pagehide"));
    });
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("drops a response-body rejection delivered before pagehide", async () => {
    let rejectBody!: (reason: unknown) => void;
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: vi.fn(() => new Promise((_resolve, reject) => {
        rejectBody = reject;
      })),
    });

    act(() => root?.render(<BiometricGate />));
    await act(flushMicrotasks);
    await act(async () => {
      rejectBody(new TypeError("settings body interrupted"));
      await flushMicrotasks();
      window.dispatchEvent(new Event("pagehide"));
    });
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("captures one genuine live response-body failure after the barrier", async () => {
    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: vi.fn().mockRejectedValue(new TypeError("live settings body failure")),
    });

    act(() => root?.render(<BiometricGate />));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Biometric setup settings lookup failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          area: "auth",
          operation: "biometric_gate_settings_lookup",
        }),
      }),
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("invalidates on hidden visibility and reloads when the document returns", async () => {
    let firstSignal: AbortSignal | null | undefined;
    const visibility = vi.spyOn(document, "visibilityState", "get");
    mocks.fetch
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        firstSignal = init.signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValueOnce({
        status: 401,
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "UNAUTHENTICATED" }),
      });

    act(() => root?.render(<BiometricGate />));
    await act(flushMicrotasks);

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(firstSignal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.capture).not.toHaveBeenCalled();
    visibility.mockRestore();
  });
});
