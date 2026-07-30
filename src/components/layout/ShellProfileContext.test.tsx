// @vitest-environment jsdom

import React, { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  fetch: vi.fn(),
  pathname: "/command",
  toast: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.capture,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import {
  ShellProfileProvider,
  useShellProfile,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const baseProfile = {
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
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;
let observed: ShellProfileContextValue | null;

function Probe() {
  const value = useShellProfile();
  observed = value;
  return (
    <output>
      {`${value.state}:${value.profile?.display_name ?? ""}:${value.draft.name}:${value.saveState}`}
    </output>
  );
}

function RouteConsumer({ name = "Route Draft" }: { name?: string }) {
  const value = useShellProfile();
  return (
    <>
      <span id="route-profile-name">{value.profile?.display_name ?? ""}</span>
      <button
        id="edit-profile"
        onClick={() =>
          value.scheduleProfileSave({ ...value.draft, name })
        }
      >
        Edit
      </button>
    </>
  );
}

function tree({
  consumer = true,
  strict = false,
  name,
}: {
  consumer?: boolean;
  strict?: boolean;
  name?: string;
} = {}) {
  const content = (
    <ShellProfileProvider>
      <Probe />
      {consumer ? <RouteConsumer name={name} /> : null}
    </ShellProfileProvider>
  );
  return strict ? <StrictMode>{content}</StrictMode> : content;
}

async function renderProvider(options?: Parameters<typeof tree>[0]) {
  act(() => root?.render(tree(options)));
  await act(flush);
}

function clickEdit() {
  const button = container.querySelector<HTMLButtonElement>("#edit-profile");
  if (!button) throw new Error("Missing route profile editor");
  act(() => button.click());
}

async function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
  await act(flush);
}

function getRequests() {
  return mocks.fetch.mock.calls.filter(
    (call) => !(call[1] as RequestInit | undefined)?.method,
  );
}

function patchRequests() {
  return mocks.fetch.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.capture.mockReset();
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  mocks.pathname = "/command";
  observed = null;
  vi.stubGlobal("fetch", mocks.fetch);
  container = document.createElement("div");
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

describe("ShellProfileProvider", () => {
  it("aborts the StrictMode replay and resolves from the remounted GET", async () => {
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
      .mockResolvedValueOnce(response(200, baseProfile));

    await renderProvider({ strict: true });

    expect(getRequests()).toHaveLength(2);
    expect(firstAborted).toBe(true);
    expect(observed?.state).toBe("ready");
    expect(observed?.profile?.display_name).toBe("Name");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a pre-debounce edit through collapse and rehydrates the committed value on re-expand", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await renderProvider();

    clickEdit();
    await renderProvider({ consumer: false });
    expect(observed?.draft.name).toBe("Route Draft");
    expect(observed?.saveState).toBe("pending");

    await advance(600);

    expect(patchRequests()).toHaveLength(1);
    expect(observed?.profile?.display_name).toBe("Route Draft");
    expect(observed?.draft.name).toBe("Route Draft");
    expect(observed?.hasPendingChanges).toBe(false);

    await renderProvider();
    expect(
      container.querySelector("#route-profile-name")?.textContent,
    ).toBe("Route Draft");
  });

  it("preserves a dirty draft across pathname refetch and commits it after navigation", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(
        response(200, { ...baseProfile, display_name: "Server Refresh" }),
      )
      .mockResolvedValueOnce(response(200, { ok: true }));
    await renderProvider();

    clickEdit();
    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });

    expect(getRequests()).toHaveLength(2);
    expect(observed?.profile?.display_name).toBe("Server Refresh");
    expect(observed?.draft.name).toBe("Route Draft");
    await advance(600);
    expect(observed?.profile?.display_name).toBe("Route Draft");
  });

  it("serializes one active write behind only the latest coalesced draft", async () => {
    let resolveFirst!: (value: ReturnType<typeof response>) => void;
    let resolveLatest!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLatest = resolve;
          }),
      );
    await renderProvider();

    act(() =>
      observed?.scheduleProfileSave({
        ...observed!.draft,
        name: "First",
      }),
    );
    await advance(600);
    act(() =>
      observed?.scheduleProfileSave({
        ...observed!.draft,
        name: "Second",
      }),
    );
    await advance(300);
    act(() =>
      observed?.scheduleProfileSave({
        ...observed!.draft,
        name: "Latest",
      }),
    );
    await advance(600);

    expect(patchRequests()).toHaveLength(1);
    resolveFirst(response(200, { ok: true }));
    await act(flush);
    expect(patchRequests()).toHaveLength(2);

    const first = patchRequests()[0]?.[1] as RequestInit;
    const latest = patchRequests()[1]?.[1] as RequestInit;
    expect(JSON.parse(String(first.body)).name).toBe("First");
    expect(JSON.parse(String(latest.body)).name).toBe("Latest");

    resolveLatest(response(200, { ok: true }));
    await act(flush);
    expect(observed?.profile?.display_name).toBe("Latest");
    expect(observed?.hasPendingChanges).toBe(false);
  });

  it("keeps 401 failure and the unsaved draft visible after editor unmount", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(401));
    await renderProvider();

    clickEdit();
    await renderProvider({ consumer: false });
    await advance(600);

    expect(observed?.state).toBe("signed-out");
    expect(observed?.draft.name).toBe("Route Draft");
    expect(observed?.saveState).toBe("session-expired");
    expect(observed?.hasPendingChanges).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Your session expired. Sign in again to save profile changes.",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("refetches after an auth-route transition without losing the blocked draft", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(200, { ok: true }));
    await renderProvider();

    clickEdit();
    await advance(600);
    expect(observed?.saveState).toBe("session-expired");

    mocks.pathname = "/login";
    await renderProvider({ consumer: false });
    expect(observed?.state).toBe("ready");
    expect(observed?.draft.name).toBe("Route Draft");
    expect(observed?.saveState).toBe("error");
    expect(observed?.hasPendingChanges).toBe(true);

    act(() => observed?.retryProfileSave());
    await act(flush);
    expect(patchRequests()).toHaveLength(2);
    expect(observed?.profile?.display_name).toBe("Route Draft");
    expect(observed?.hasPendingChanges).toBe(false);
  });

  it("shows server failure after editor unmount without client recapture", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(503, { error: "unavailable" }));
    await renderProvider();

    clickEdit();
    await renderProvider({ consumer: false });
    await advance(600);

    expect(observed?.saveState).toBe("error");
    expect(observed?.hasPendingChanges).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Profile changes were not saved",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects repeated malformed lookup payloads without duplicate capture", async () => {
    const malformed = {
      ...baseProfile,
      extra: "unexpected",
    };
    mocks.fetch
      .mockResolvedValueOnce(response(200, malformed))
      .mockResolvedValueOnce(response(200, malformed));
    await renderProvider();
    expect(observed?.state).toBe("error");

    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });

    expect(observed?.state).toBe("error");
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
  });

  it("captures only the latest queued network failure once", async () => {
    let rejectFirst!: (reason: unknown) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockRejectedValueOnce(new TypeError("same private outage"));
    await renderProvider();

    act(() =>
      observed?.scheduleProfileSave({
        ...observed!.draft,
        name: "First",
      }),
    );
    await advance(600);
    act(() =>
      observed?.scheduleProfileSave({
        ...observed!.draft,
        name: "Latest",
      }),
    );
    await advance(600);

    rejectFirst(new TypeError("same private outage"));
    await act(flush);

    expect(patchRequests()).toHaveLength(2);
    expect(observed?.saveState).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Profile save client failure" }),
      {
        tags: {
          area: "navigation",
          operation: "profile_save_network",
        },
      },
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "same private outage",
    );
  });

  it("does not commit a malformed success response", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, baseProfile))
      .mockResolvedValueOnce(response(200, { ok: false }));
    await renderProvider();

    clickEdit();
    await advance(600);

    expect(observed?.profile?.display_name).toBe("Name");
    expect(observed?.draft.name).toBe("Route Draft");
    expect(observed?.saveState).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          area: "navigation",
          operation: "profile_save_response",
        },
      },
    );
  });

  it("warns before a full-page exit while a draft is pending", async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, baseProfile));
    await renderProvider();
    clickEdit();

    const event = new Event("beforeunload", {
      bubbles: false,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
