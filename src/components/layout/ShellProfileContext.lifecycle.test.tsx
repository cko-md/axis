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
vi.mock("next/navigation", () => ({ usePathname: () => "/command" }));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/components/nav/cropImage", () => ({
  getCroppedImageBlob: vi.fn(),
}));

import {
  ShellProfileProvider,
  useShellProfile,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let root: Root | null;
let observed: ShellProfileContextValue | null;

function Probe() {
  observed = useShellProfile();
  return <output>{observed.state}</output>;
}

function current() {
  if (!observed) throw new Error("Profile context was not observed");
  return observed;
}

async function renderProvider() {
  act(() => root?.render(
    <ShellProfileProvider>
      <Probe />
    </ShellProfileProvider>,
  ));
  await act(flush);
}

async function advanceFailureCommit() {
  act(() => vi.advanceTimersByTime(0));
  await act(flush);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.capture.mockReset();
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  observed = null;
  vi.stubGlobal("fetch", mocks.fetch);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  observed = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ShellProfileProvider lookup lifecycle", () => {
  it("captures the identical TypeError once while the lookup remains current", async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError("same live-looking failure"));
    await renderProvider();

    expect(current().state).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Shell profile lookup failed" }),
      { tags: { area: "navigation", operation: "shell_profile_lookup" } },
    );
  });

  it("aborts and consumes a TypeError that races with pagehide", async () => {
    let rejectLookup!: (reason: unknown) => void;
    let lookupSignal: AbortSignal | null | undefined;
    mocks.fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      lookupSignal = init.signal;
      return new Promise((_resolve, reject) => {
        rejectLookup = reject;
      });
    });
    await renderProvider();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(lookupSignal?.aborted).toBe(true);
    rejectLookup(new TypeError("same live-looking failure"));
    await advanceFailureCommit();

    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

});
