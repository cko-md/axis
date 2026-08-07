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
  ShellProfileContext,
  ShellProfileProvider,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const SUBJECT = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;

let root: Root | null;
let observed: ShellProfileContextValue | null;

function Probe() {
  observed = React.useContext(ShellProfileContext);
  return null;
}

function current() {
  if (!observed) throw new Error("Profile context was not observed");
  return observed;
}

function profileResponsePayload() {
  return {
    subject: SUBJECT,
    display_name: "Owner",
    role_title: null,
    bio: null,
    avatar_url: null,
    email: "owner@example.test",
  };
}

function responseValue(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
  };
}

function deferredResponse() {
  let resolve!: (value: ReturnType<typeof responseValue>) => void;
  const promise = new Promise<ReturnType<typeof responseValue>>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function profileResponse() {
  return responseValue(200, profileResponsePayload());
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

describe("ShellProfileProvider navigation failure commit", () => {
  it("drops a fetch rejection delivered before the following pagehide macrotask", async () => {
    let rejectLookup!: (reason: unknown) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectLookup = reject;
    }));

    act(() => root?.render(
      <ShellProfileProvider>
        <span>shell</span>
      </ShellProfileProvider>,
    ));
    await act(flushMicrotasks);

    await act(async () => {
      rejectLookup(new Error("navigation interrupted the profile fetch"));
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

    act(() => root?.render(
      <ShellProfileProvider>
        <span>shell</span>
      </ShellProfileProvider>,
    ));
    await act(flushMicrotasks);
    await act(async () => {
      rejectBody(new TypeError("profile body interrupted"));
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
      json: vi.fn().mockRejectedValue(new TypeError("live profile body failure")),
    });

    act(() => root?.render(
      <ShellProfileProvider>
        <span>shell</span>
      </ShellProfileProvider>,
    ));
    await act(flushMicrotasks);
    act(() => vi.advanceTimersByTime(0));
    await act(flushMicrotasks);

    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Shell profile lookup failed" }),
      { tags: { area: "navigation", operation: "shell_profile_lookup" } },
    );
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

    act(() => root?.render(
      <ShellProfileProvider>
        <span>shell</span>
      </ShellProfileProvider>,
    ));
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

  it("quarantines profile identity without cancelling hidden-tab saves or uploads", async () => {
    let saveSignal: AbortSignal | null | undefined;
    let uploadSignal: AbortSignal | null | undefined;
    let resolveSave!: (value: unknown) => void;
    let resolveUpload!: (value: unknown) => void;
    let resolveReload!: (value: unknown) => void;
    let profileGetCount = 0;
    const visibility = vi.spyOn(document, "visibilityState", "get");
    mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/profile" && init?.method === "PATCH") {
        saveSignal = init.signal;
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      }
      if (url === "/api/profile/avatar") {
        uploadSignal = init?.signal;
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
      profileGetCount += 1;
      if (profileGetCount === 1) return Promise.resolve(profileResponse());
      return new Promise((resolve) => {
        resolveReload = resolve;
      });
    });

    act(() => root?.render(
      <ShellProfileProvider>
        <Probe />
      </ShellProfileProvider>,
    ));
    await act(flushMicrotasks);

    act(() => current().scheduleProfileSave({
      ...current().draft,
      name: "Owner edited",
    }));
    act(() => vi.advanceTimersByTime(600));
    await act(flushMicrotasks);
    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["avatar"], { type: "image/jpeg" }),
        SUBJECT,
      );
    });
    await act(flushMicrotasks);
    expect(current().saveState).toBe("saving");
    expect(current().uploadState).toBe("uploading");

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(saveSignal?.aborted).toBe(false);
    expect(uploadSignal?.aborted).toBe(false);
    expect(current().draft.name).toBe("Owner edited");
    expect(current().saveState).toBe("saving");
    expect(current().uploadState).toBe("uploading");
    expect(current().hasPendingChanges).toBe(true);
    expect(current().profile).toBeNull();
    expect(current().state).toBe("loading");

    resolveSave({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, subject: SUBJECT }),
    });
    await act(flushMicrotasks);
    expect(current().profile?.display_name).toBe("Owner edited");

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);

    expect(current().profile).toBeNull();
    expect(current().state).toBe("loading");

    resolveReload({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        ...(await profileResponse().json()),
        display_name: "Authoritative owner",
      }),
    });
    await act(flushMicrotasks);

    expect(current().profile?.display_name).toBe("Authoritative owner");
    expect(current().state).toBe("ready");
    expect(uploadSignal?.aborted).toBe(false);

    resolveUpload({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({
        url: "https://cdn.example.test/avatar.jpg",
        subject: SUBJECT,
      }),
    });
    await act(async () => uploadPromise);

    expect(current().uploadState).toBe("idle");
    expect(current().draft.photo).toBe("https://cdn.example.test/avatar.jpg");
    visibility.mockRestore();
  });

  it("keeps hidden A conflicts quarantined until a visible B lookup", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const save = deferredResponse();
    const upload = deferredResponse();
    let getCount = 0;
    mocks.fetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/auth/profile" && init?.method === "PATCH") {
        return save.promise;
      }
      if (url === "/api/profile/avatar") return upload.promise;
      getCount += 1;
      return Promise.resolve(
        getCount === 1
          ? profileResponse()
          : {
              status: 200,
              ok: true,
              json: vi.fn().mockResolvedValue({
                ...(profileResponsePayload()),
                subject: SUBJECT_B,
                display_name: "Owner B",
              }),
            },
      );
    });

    act(() => root?.render(
      <ShellProfileProvider>
        <Probe />
      </ShellProfileProvider>,
    ));
    await act(flushMicrotasks);
    act(() => current().scheduleProfileSave({
      ...current().draft,
      name: "Owner A edit",
    }));
    act(() => vi.advanceTimersByTime(600));
    await act(flushMicrotasks);
    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["avatar"], { type: "image/jpeg" }),
        SUBJECT,
      );
    });
    await act(flushMicrotasks);

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    save.resolve(responseValue(409, { error: "PROFILE_SUBJECT_CHANGED" }));
    upload.resolve(responseValue(409, { error: "PROFILE_SUBJECT_CHANGED" }));
    await act(async () => uploadPromise);
    await act(flushMicrotasks);

    expect(getCount).toBe(1);
    expect(current().profile).toBeNull();
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flushMicrotasks);
    expect(getCount).toBe(1);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(flushMicrotasks);

    expect(getCount).toBe(2);
    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().profile?.display_name).toBe("Owner B");
  });
});
