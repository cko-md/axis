// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  fetch: vi.fn(),
  toast: vi.fn(),
}));

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;

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
  type ShellProfile,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const profile = (
  subject = SUBJECT_A,
  displayName = "Restored Owner",
): ShellProfile => ({
  subject,
  display_name: displayName,
  role_title: "Owner",
  bio: null,
  avatar_url: null,
  email: "restored@example.test",
});

const response = (status: number, body?: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn().mockResolvedValue(body),
});

function persistedPageEvent(type: "pagehide" | "pageshow") {
  const event = new Event(type) as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: true });
  return event;
}

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
  it("ignores an unpaired pageshow without duplicating the initial lookup", async () => {
    mocks.fetch.mockResolvedValueOnce(response(200, profile()));
    await renderProvider();

    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flush);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(current().state).toBe("ready");
  });

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

  it.each([false, true])(
    "reports a fresh live failure after pagehide and pageshow (persisted=%s)",
    async (persisted) => {
      mocks.fetch
        .mockRejectedValueOnce(new TypeError("first live failure"))
        .mockRejectedValueOnce(new TypeError("restored live failure"));
      await renderProvider();

      expect(current().state).toBe("error");
      expect(mocks.capture).toHaveBeenCalledTimes(1);

      act(() =>
        window.dispatchEvent(
          persisted ? persistedPageEvent("pagehide") : new Event("pagehide"),
        ),
      );
      act(() =>
        window.dispatchEvent(
          persisted ? persistedPageEvent("pageshow") : new Event("pageshow"),
        ),
      );
      await act(flush);

      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(current().state).toBe("error");
      expect(mocks.capture).toHaveBeenCalledTimes(2);
    },
  );

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

  it("restarts an aborted lookup after an ordinary pageshow", async () => {
    let lookupSignal: AbortSignal | null | undefined;
    let resolveInterrupted!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        lookupSignal = init.signal;
        return new Promise((resolve) => {
          resolveInterrupted = resolve;
        });
      })
      .mockResolvedValueOnce(response(200, profile()));
    await renderProvider();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(lookupSignal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flush);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(current().state).toBe("ready");
    expect(current().profile?.display_name).toBe("Restored Owner");

    resolveInterrupted(response(200, { ...profile(), display_name: "Stale Owner" }));
    await act(flush);
    expect(current().profile?.display_name).toBe("Restored Owner");
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("quarantines the former subject until a BFCache lookup proves the restored owner", async () => {
    let resolveRestored!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile(SUBJECT_A, "Owner A")))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRestored = resolve;
      }));
    await renderProvider();
    act(() => current().scheduleProfileSave({
      ...current().draft,
      name: "Private Draft A",
      bio: "Former-subject private draft",
    }));

    act(() => window.dispatchEvent(persistedPageEvent("pagehide")));
    expect(current().state).toBe("loading");
    expect(current().profile).toBeNull();
    expect(current().draft).toEqual({ name: "", role: "", bio: "", photo: "" });

    act(() => window.dispatchEvent(persistedPageEvent("pageshow")));
    await act(flush);
    expect(current().state).toBe("loading");
    expect(current().profile).toBeNull();
    expect(JSON.stringify(current().draft)).not.toContain("Private Draft A");
    expect(JSON.stringify(current().draft)).not.toContain("Former-subject private draft");

    resolveRestored(response(200, profile(SUBJECT_B, "Owner B")));
    await act(flush);

    expect(current().state).toBe("ready");
    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().draft.name).toBe("Owner B");
    expect(JSON.stringify(current())).not.toContain("Private Draft A");
    expect(JSON.stringify(current())).not.toContain("Former-subject private draft");
  });

  it("retires an in-flight save before an ordinary pageshow lookup", async () => {
    let saveSignal: AbortSignal | null | undefined;
    let resolveSave!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        saveSignal = init.signal;
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      })
      .mockResolvedValueOnce(response(200, profile()));
    await renderProvider();

    act(() => current().scheduleProfileSave({ ...current().draft, name: "Stale Save" }));
    act(() => vi.advanceTimersByTime(600));
    await act(flush);
    expect(saveSignal).toBeDefined();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(saveSignal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flush);
    resolveSave(response(200, { ok: true, subject: profile().subject }));
    await act(flush);

    expect(current().profile?.display_name).toBe("Restored Owner");
    expect(current().draft.name).toBe("Stale Save");
    expect(current().saveState).toBe("error");
    expect(current().hasPendingChanges).toBe(true);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("retires an in-flight avatar upload before an ordinary pageshow lookup", async () => {
    let uploadSignal: AbortSignal | null | undefined;
    let resolveUpload!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        uploadSignal = init.signal;
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      })
      .mockResolvedValueOnce(response(200, profile()));
    await renderProvider();

    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        profile().subject,
      );
    });
    await act(flush);
    expect(uploadSignal).toBeDefined();

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(uploadSignal?.aborted).toBe(true);
    act(() => window.dispatchEvent(new Event("pageshow")));
    await act(flush);
    resolveUpload(response(200, {
      url: "https://cdn.test/stale-avatar.jpg",
      subject: profile().subject,
    }));
    await act(async () => uploadPromise);

    expect(current().draft.photo).not.toBe("https://cdn.test/stale-avatar.jpg");
    expect(current().uploadState).toBe("error");
    expect(current().hasPendingChanges).toBe(false);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

});
