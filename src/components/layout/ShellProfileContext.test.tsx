// @vitest-environment jsdom

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.capture,
}));

import {
  ShellProfileProvider,
  useShellProfile,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const goodProfile = {
  display_name: "Name",
  role_title: "Role",
  bio: null,
  avatar_url: null,
  email: "account@example.test",
};

const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn().mockResolvedValue(body),
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;

function Probe() {
  const { state, profile } = useShellProfile();
  return <div>{`${state}:${profile?.display_name ?? ""}`}</div>;
}

function renderProvider(strict = false) {
  const content = (
    <ShellProfileProvider>
      <Probe />
    </ShellProfileProvider>
  );
  act(() => {
    root?.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
}

beforeEach(() => {
  mocks.capture.mockReset();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ShellProfileProvider", () => {
  it("aborts the StrictMode replay and resolves from the remounted read", async () => {
    let firstAborted = false;
    mocks.fetch
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              firstAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce(response(200, goodProfile));

    renderProvider(true);
    await act(flush);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(firstAborted).toBe(true);
    expect(container.textContent).toBe("ready:Name");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("maps 401 to signed out without observability noise", async () => {
    mocks.fetch.mockResolvedValueOnce(response(401));

    renderProvider();
    await act(flush);

    expect(container.textContent).toBe("signed-out:");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("shows server response failures without recapturing them", async () => {
    const serverResponse = response(503, {
      error: "PROFILE_ACCOUNT_UNAVAILABLE",
    });
    mocks.fetch.mockResolvedValueOnce(serverResponse);

    renderProvider();
    await act(flush);

    expect(container.textContent).toBe("error:");
    expect(serverResponse.json).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures a malformed success once with fixed safe metadata", async () => {
    mocks.fetch.mockResolvedValueOnce(
      response(200, { ...goodProfile, role_title: 42 }),
    );

    renderProvider();
    await act(flush);

    expect(container.textContent).toBe("error:");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Shell profile lookup failed" }),
      {
        tags: {
          area: "navigation",
          operation: "shell_profile_lookup",
        },
      },
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain("42");
  });

  it("captures a genuine network failure once without raw detail", async () => {
    mocks.fetch.mockRejectedValueOnce(
      new TypeError("private network transport detail"),
    );

    renderProvider();
    await act(flush);

    expect(container.textContent).toBe("error:");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Shell profile lookup failed" }),
      {
        tags: {
          area: "navigation",
          operation: "shell_profile_lookup",
        },
      },
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private network transport detail",
    );
  });

  it("aborts an active read on unmount without feedback", async () => {
    let aborted = false;
    mocks.fetch.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });

    renderProvider();
    act(() => root?.unmount());
    root = null;
    await act(flush);

    expect(aborted).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
