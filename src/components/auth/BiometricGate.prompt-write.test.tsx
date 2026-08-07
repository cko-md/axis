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
  // Deliberately return a new callback identity on every consumer render.
  useToast: () => ({ toast: (...args: unknown[]) => mocks.toast(...args) }),
}));

import BiometricGate from "./BiometricGate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

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

describe("BiometricGate prompted-write integration", () => {
  it("does not auto-retry after a live failure when toast and parent callbacks change identity", async () => {
    let postCount = 0;
    mocks.fetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        return Promise.resolve(
          postCount === 1
            ? response(500, { error: "AUTH_SETTINGS_UNAVAILABLE" })
            : response(200, { ok: true }),
        );
      }
      return Promise.resolve(response(200, { biometric_prompted: false }));
    });

    act(() => root?.render(<BiometricGate />));
    await act(flush);
    act(() => vi.advanceTimersByTime(0));
    await act(flush);

    expect(postCount).toBe(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    // Re-rendering the Gate recreates its inline prompt callbacks; useToast
    // also returns a new callback. Neither is authority to repeat the POST.
    act(() => root?.render(<BiometricGate />));
    await act(flush);
    act(() => vi.advanceTimersByTime(0));
    await act(flush);

    expect(postCount).toBe(1);
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await act(flush);

    expect(postCount).toBe(2);
  });
});
