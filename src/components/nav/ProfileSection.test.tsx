// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShellProfileContext,
  type ShellProfileContextValue,
} from "@/components/layout/ShellProfileContext";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  toast: vi.fn(),
  fetch: vi.fn(),
  profileName: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.capture,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("react-easy-crop", () => ({ default: () => null }));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <>
      {children}
      {footer}
    </>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("./cropImage", () => ({ getCroppedImageBlob: vi.fn() }));

import { ProfileSection } from "./ProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const readyProfile: ShellProfileContextValue = {
  state: "ready",
  profile: {
    display_name: "Name",
    role_title: "Role",
    bio: null,
    avatar_url: null,
    email: "account@example.test",
  },
};

const response = (status: number) => ({
  status,
  ok: status >= 200 && status < 300,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;

async function renderProfile(
  value: ShellProfileContextValue = readyProfile,
) {
  act(() => {
    root?.render(
      <ShellProfileContext.Provider value={value}>
        <ProfileSection
          onSignOut={vi.fn()}
          onProfileName={mocks.profileName}
        />
      </ShellProfileContext.Provider>,
    );
  });
  await act(flush);
  act(() => vi.advanceTimersByTime(0));
  await act(flush);
}

function setInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(id);
  if (!input) throw new Error(`Missing input ${id}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function startDebouncedSave() {
  act(() => vi.advanceTimersByTime(600));
  await act(flush);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.capture.mockReset();
  mocks.toast.mockReset();
  mocks.fetch.mockReset();
  mocks.profileName.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  container = document.createElement("div");
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

describe("ProfileSection autosave", () => {
  it("hydrates from shell context and saves a valid edit", async () => {
    mocks.fetch.mockResolvedValueOnce(response(200));
    await renderProfile();
    mocks.profileName.mockReset();

    setInput("#profile-name", "Saved Name");
    await startDebouncedSave();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/auth/profile",
      expect.objectContaining({
        method: "PATCH",
        signal: expect.any(AbortSignal),
      }),
    );
    const init = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Saved Name",
      role: "Role",
      bio: "",
      photo: "",
    });
    expect(mocks.profileName).toHaveBeenCalledWith("Saved Name");
    expect(container.textContent).toContain("Saved");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("preserves the unsaved form and gives explicit 401 feedback", async () => {
    mocks.fetch.mockResolvedValueOnce(response(401));
    await renderProfile();
    mocks.profileName.mockReset();

    const input = setInput("#profile-name", "Unsaved Name");
    await startDebouncedSave();

    expect(input.value).toBe("Unsaved Name");
    expect(container.textContent).toContain(
      "Session expired — changes not saved",
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      "Your session expired. Sign in again to save profile changes.",
      "error",
      "Profile",
    );
    expect(mocks.profileName).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures a network failure once with fixed safe metadata", async () => {
    mocks.fetch.mockRejectedValueOnce(
      new TypeError("private network transport detail"),
    );
    await renderProfile();
    mocks.profileName.mockReset();

    setInput("#profile-name", "Network Failure");
    await startDebouncedSave();

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Profile save network failure" }),
      {
        tags: {
          area: "navigation",
          operation: "profile_save_network",
        },
      },
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private network transport detail",
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not save profile",
      "error",
      "Profile",
    );
  });

  it("shows a server failure without client recapture", async () => {
    mocks.fetch.mockResolvedValueOnce(response(503));
    await renderProfile();

    setInput("#profile-name", "Server Failure");
    await startDebouncedSave();

    expect(container.textContent).toContain("Retry pending");
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not save profile",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("serializes rapid saves so the newest request reaches the server last", async () => {
    let resolveFirst!: (value: ReturnType<typeof response>) => void;
    let resolveSecond!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    await renderProfile();
    mocks.profileName.mockReset();

    setInput("#profile-name", "First");
    await startDebouncedSave();
    setInput("#profile-name", "Second");
    await startDebouncedSave();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.profileName).not.toHaveBeenCalled();

    resolveFirst(response(200));
    await act(flush);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.profileName).not.toHaveBeenCalled();

    const first = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const second = mocks.fetch.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(first.body)).name).toBe("First");
    expect(JSON.parse(String(second.body)).name).toBe("Second");

    resolveSecond(response(200));
    await act(flush);
    expect(mocks.profileName).toHaveBeenCalledTimes(1);
    expect(mocks.profileName).toHaveBeenCalledWith("Second");
  });

  it("aborts the active save and discards queued work on unmount", async () => {
    mocks.fetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    await renderProfile();
    mocks.profileName.mockReset();

    setInput("#profile-name", "First");
    await startDebouncedSave();
    setInput("#profile-name", "Second");
    await startDebouncedSave();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const activeInit = mocks.fetch.mock.calls[0]?.[1] as RequestInit;

    act(() => root?.unmount());
    root = null;
    await act(flush);

    expect(activeInit.signal?.aborted).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.profileName).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
