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
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import BiometricPrompt from "./BiometricPrompt";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let root: Root | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  vi.clearAllMocks();
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

describe("BiometricPrompt prompted-write lifecycle", () => {
  it("does not show the prompt until its prompted status is durably saved", async () => {
    let resolve!: (response: { ok: boolean; status: number }) => void;
    mocks.fetch.mockReturnValueOnce(new Promise((resolvePromise) => {
      resolve = resolvePromise;
    }));

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={vi.fn()} onEnable={vi.fn()} />,
    ));
    await act(flush);
    expect(document.body.textContent).not.toContain(
      "Use a passkey for faster sign-in?",
    );

    resolve({ ok: true, status: 200 });
    await act(flush);
    expect(document.body.textContent).toContain(
      "Use a passkey for faster sign-in?",
    );
  });

  it("surfaces and reports a current prompted-write failure with retry", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: "AUTH_SETTINGS_UNAVAILABLE" }),
    });

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={vi.fn()} onEnable={vi.fn()} />,
    ));
    await act(flush);
    act(() => vi.advanceTimersByTime(0));
    await act(flush);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This prompt status was not saved",
    );
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Biometric prompt status save failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          operation: "biometric_prompt_status_save",
          status: "500",
        }),
      }),
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not save passkey prompt status. It may appear again.",
      "error",
      "Security",
    );
  });

  it("silently defers an exact MFA boundary between lookup and prompted write", async () => {
    const onDismiss = vi.fn();
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({
        error: "MFA_REQUIRED",
        message: "Complete two-factor authentication to continue.",
      }),
    });

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={onDismiss} onEnable={vi.fn()} />,
    ));
    await act(flush);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("silently defers an exact signed-out boundary between lookup and prompted write", async () => {
    const onDismiss = vi.fn();
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: "Unauthenticated" }),
    });

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={onDismiss} onEnable={vi.fn()} />,
    ));
    await act(flush);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("reports a near-miss MFA payload instead of suppressing it", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: vi.fn().mockResolvedValue({
        error: "MFA_REQUIRED",
        message: "Complete two-factor authentication to continue",
      }),
    });

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={vi.fn()} onEnable={vi.fn()} />,
    ));
    await act(flush);
    act(() => vi.advanceTimersByTime(0));
    await act(flush);

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("aborts and consumes a prompted-write rejection after pagehide", async () => {
    let reject!: (reason: unknown) => void;
    mocks.fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    });

    act(() => root?.render(
      <BiometricPrompt isSupported={false} onDismiss={vi.fn()} onEnable={vi.fn()} />,
    ));
    await act(flush);
    act(() => window.dispatchEvent(new Event("pagehide")));
    reject(new TypeError("navigation cancelled write"));
    await act(flush);
    act(() => vi.advanceTimersByTime(0));
    await act(flush);

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
