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
  type ShellProfile,
  type ShellProfileContextValue,
} from "./ShellProfileContext";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SUBJECT_A = `ps1_${"a".repeat(64)}`;
const SUBJECT_B = `ps1_${"b".repeat(64)}`;

function profile(
  subject = SUBJECT_A,
  displayName = "Name A",
): ShellProfile {
  return {
    subject,
    display_name: displayName,
    role_title: `Role ${displayName.slice(-1)}`,
    bio: null,
    avatar_url: null,
    email: `${displayName.replaceAll(" ", "").toLowerCase()}@example.test`,
  };
}

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
      {`${value.state}:${value.profile?.subject ?? ""}:${value.profile?.display_name ?? ""}:${value.draft.name}:${value.saveState}:${value.uploadState}`}
    </output>
  );
}

function RouteConsumer({ name = "Draft A" }: { name?: string }) {
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

function current() {
  if (!observed) throw new Error("Profile context was not observed");
  return observed;
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

function uploadRequests() {
  return mocks.fetch.mock.calls.filter(
    (call) => call[0] === "/api/profile/avatar",
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

describe("ShellProfileProvider identity and persistence", () => {
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
      .mockResolvedValueOnce(response(200, profile()));

    await renderProvider({ strict: true });

    expect(getRequests()).toHaveLength(2);
    expect(firstAborted).toBe(true);
    expect(current().state).toBe("ready");
    expect(current().profile?.subject).toBe(SUBJECT_A);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("keeps a pre-debounce edit through collapse and rehydrates the committed value", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(200, { ok: true, subject: SUBJECT_A }),
      );
    await renderProvider();

    clickEdit();
    await renderProvider({ consumer: false });
    expect(current().draft.name).toBe("Draft A");
    expect(current().saveState).toBe("pending");

    await advance(600);

    expect(patchRequests()).toHaveLength(1);
    const body = JSON.parse(
      String((patchRequests()[0]?.[1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      subject: SUBJECT_A,
      name: "Draft A",
    });
    expect(current().profile?.display_name).toBe("Draft A");
    expect(current().hasPendingChanges).toBe(false);

    await renderProvider();
    expect(
      container.querySelector("#route-profile-name")?.textContent,
    ).toBe("Draft A");
  });

  it("serializes one active write behind only the latest subject-bound draft", async () => {
    let resolveFirst!: (value: ReturnType<typeof response>) => void;
    let resolveLatest!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
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
      current().scheduleProfileSave({
        ...current().draft,
        name: "First A",
      }),
    );
    await advance(600);
    act(() =>
      current().scheduleProfileSave({
        ...current().draft,
        name: "Second A",
      }),
    );
    await advance(300);
    act(() =>
      current().scheduleProfileSave({
        ...current().draft,
        name: "Latest A",
      }),
    );
    await advance(600);

    expect(patchRequests()).toHaveLength(1);
    resolveFirst(response(200, { ok: true, subject: SUBJECT_A }));
    await act(flush);
    expect(patchRequests()).toHaveLength(2);

    const first = JSON.parse(
      String((patchRequests()[0]?.[1] as RequestInit).body),
    );
    const latest = JSON.parse(
      String((patchRequests()[1]?.[1] as RequestInit).body),
    );
    expect(first).toMatchObject({ subject: SUBJECT_A, name: "First A" });
    expect(latest).toMatchObject({
      subject: SUBJECT_A,
      name: "Latest A",
    });

    resolveLatest(response(200, { ok: true, subject: SUBJECT_A }));
    await act(flush);
    expect(current().profile?.display_name).toBe("Latest A");
  });

  it("retains a dirty draft across same-subject reauthentication", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(200, { ok: true, subject: SUBJECT_A }),
      );
    await renderProvider();

    clickEdit();
    await advance(600);
    expect(current().state).toBe("signed-out");
    expect(current().draft.name).toBe("Draft A");

    mocks.pathname = "/login";
    await renderProvider({ consumer: false });
    expect(current().state).toBe("ready");
    expect(current().profile?.subject).toBe(SUBJECT_A);
    expect(current().draft.name).toBe("Draft A");
    expect(current().saveState).toBe("error");

    act(() => current().retryProfileSave());
    await act(flush);
    expect(patchRequests()).toHaveLength(2);
    expect(current().profile?.display_name).toBe("Draft A");
  });

  it("quarantines A on A-to-401-to-B and never renders or submits it as B", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, profile(SUBJECT_B, "Name B")))
      .mockResolvedValueOnce(response(200, profile()));
    await renderProvider();

    clickEdit();
    await advance(600);
    expect(current().draft.name).toBe("Draft A");

    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });

    expect(current().state).toBe("ready");
    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().profile?.display_name).toBe("Name B");
    expect(current().draft.name).toBe("Name B");
    expect(current().hasPendingChanges).toBe(false);
    expect(patchRequests()).toHaveLength(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Unsaved profile changes were set aside for the previous account.",
      "error",
      "Profile",
    );

    act(() => current().retryProfileSave());
    await act(flush);
    expect(patchRequests()).toHaveLength(1);

    mocks.pathname = "/command";
    await renderProvider({ consumer: false });
    expect(current().profile?.subject).toBe(SUBJECT_A);
    expect(current().draft.name).toBe("Draft A");
    expect(current().hasPendingChanges).toBe(true);
  });

  it("ignores an active A write response after B becomes current", async () => {
    let resolveA!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValueOnce(response(200, profile(SUBJECT_B, "Name B")))
      .mockResolvedValueOnce(
        response(200, { ok: true, subject: SUBJECT_B }),
      );
    await renderProvider();

    clickEdit();
    await advance(600);
    expect(patchRequests()).toHaveLength(1);

    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });
    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().draft.name).toBe("Name B");

    resolveA(response(200, { ok: true, subject: SUBJECT_A }));
    await act(flush);
    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().draft.name).toBe("Name B");

    act(() =>
      current().scheduleProfileSave({
        ...current().draft,
        name: "Draft B",
      }),
    );
    await advance(600);
    expect(patchRequests()).toHaveLength(2);
    const body = JSON.parse(
      String((patchRequests()[1]?.[1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      subject: SUBJECT_B,
      name: "Draft B",
    });
    expect(JSON.stringify(body)).not.toContain("Draft A");
  });
});

describe("ShellProfileProvider failures and MFA", () => {
  it("keeps a 503 visible after the editor unmounts without client recapture", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(503, { error: "unavailable" }),
      );
    await renderProvider();

    clickEdit();
    await renderProvider({ consumer: false });
    await advance(600);

    expect(current().saveState).toBe("error");
    expect(current().hasPendingChanges).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Profile changes were not saved",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("captures only the latest subject-bound network failure once", async () => {
    let rejectFirst!: (reason: unknown) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockRejectedValueOnce(new TypeError("same private outage"));
    await renderProvider();

    act(() =>
      current().scheduleProfileSave({
        ...current().draft,
        name: "First A",
      }),
    );
    await advance(600);
    act(() =>
      current().scheduleProfileSave({
        ...current().draft,
        name: "Latest A",
      }),
    );
    await advance(600);
    rejectFirst(new TypeError("same private outage"));
    await act(flush);

    expect(patchRequests()).toHaveLength(2);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Profile client operation failed" }),
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

  it("does not commit a success response bound to another subject", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(200, { ok: true, subject: SUBJECT_B }),
      );
    await renderProvider();

    clickEdit();
    await advance(600);

    expect(current().profile?.display_name).toBe("Name A");
    expect(current().draft.name).toBe("Draft A");
    expect(current().saveState).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        area: "navigation",
        operation: "profile_save_response",
      },
    });
  });

  it("exposes actionable MFA state from GET", async () => {
    mocks.fetch.mockResolvedValueOnce(
      response(403, {
        error: "MFA_REQUIRED",
        message: "Complete two-factor authentication.",
      }),
    );

    await renderProvider();

    expect(current().state).toBe("mfa-required");
    expect(current().saveState).toBe("idle");
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("retains a dirty draft and exposes actionable MFA state from PATCH", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(403, {
          error: "MFA_REQUIRED",
          message: "Complete two-factor authentication.",
        }),
      );
    await renderProvider();

    clickEdit();
    await advance(600);

    expect(current().state).toBe("mfa-required");
    expect(current().saveState).toBe("mfa-required");
    expect(current().draft.name).toBe("Draft A");
    expect(current().hasPendingChanges).toBe(true);
    expect(mocks.toast).toHaveBeenCalledWith(
      "Complete two-factor authentication to save profile changes.",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("rejects repeated malformed lookup payloads without duplicate capture", async () => {
    const malformed = {
      ...profile(),
      subject: "owner",
    };
    mocks.fetch
      .mockResolvedValueOnce(response(200, malformed))
      .mockResolvedValueOnce(response(200, malformed));
    await renderProvider();
    expect(current().state).toBe("error");

    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });

    expect(current().state).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });
});

describe("ShellProfileProvider avatar ownership", () => {
  it("tracks upload pending state in the root and warns before full-page exit", async () => {
    let resolveUpload!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
      );
    await renderProvider();

    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        SUBJECT_A,
      );
    });
    await act(flush);

    expect(current().uploadState).toBe("uploading");
    expect(current().hasPendingChanges).toBe(true);
    const event = new Event("beforeunload", {
      bubbles: false,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const form = (uploadRequests()[0]?.[1] as RequestInit).body as FormData;
    expect(form.get("subject")).toBe(SUBJECT_A);

    resolveUpload(
      response(200, {
        url: "https://cdn.test/avatar-a.jpg",
        subject: SUBJECT_A,
      }),
    );
    await act(async () => uploadPromise);
    expect(current().draft.photo).toBe("https://cdn.test/avatar-a.jpg");
    expect(current().saveState).toBe("pending");
  });

  it("completes a subject-bound upload after the route consumer unmounts", async () => {
    let resolveUpload!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
      )
      .mockResolvedValueOnce(
        response(200, { ok: true, subject: SUBJECT_A }),
      );
    await renderProvider();

    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        SUBJECT_A,
      );
    });
    await renderProvider({ consumer: false });
    resolveUpload(
      response(200, {
        url: "https://cdn.test/avatar-a.jpg",
        subject: SUBJECT_A,
      }),
    );
    await act(async () => uploadPromise);

    expect(current().draft.photo).toBe("https://cdn.test/avatar-a.jpg");
    expect(current().hasPendingChanges).toBe(true);
    await advance(600);
    expect(patchRequests()).toHaveLength(1);
    const body = JSON.parse(
      String((patchRequests()[0]?.[1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      subject: SUBJECT_A,
      photo: "https://cdn.test/avatar-a.jpg",
    });
  });

  it("never attaches an A upload response after switching to B", async () => {
    let resolveUpload!: (value: ReturnType<typeof response>) => void;
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
      )
      .mockResolvedValueOnce(response(200, profile(SUBJECT_B, "Name B")));
    await renderProvider();

    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        SUBJECT_A,
      );
    });
    await act(flush);

    mocks.pathname = "/notes";
    await renderProvider({ consumer: false });
    expect(current().profile?.subject).toBe(SUBJECT_B);

    resolveUpload(
      response(200, {
        url: "https://cdn.test/avatar-a.jpg",
        subject: SUBJECT_A,
      }),
    );
    await act(async () => uploadPromise);

    expect(current().profile?.subject).toBe(SUBJECT_B);
    expect(current().draft.photo).toBe("");
    expect(patchRequests()).toHaveLength(0);
    expect(mocks.toast).toHaveBeenCalledWith(
      "The profile photo upload stopped because the signed-in account changed.",
      "error",
      "Profile",
    );
  });

  it("captures an upload network failure once with fixed safe metadata", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockRejectedValueOnce(
        new TypeError("private avatar transport detail"),
      );
    await renderProvider();

    await act(async () => {
      await current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        SUBJECT_A,
      );
    });

    expect(current().uploadState).toBe("error");
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Profile client operation failed" }),
      {
        tags: {
          area: "navigation",
          operation: "profile_avatar_upload_network",
        },
      },
    );
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toContain(
      "private avatar transport detail",
    );
  });

  it("shows an avatar server failure without client recapture", async () => {
    mocks.fetch
      .mockResolvedValueOnce(response(200, profile()))
      .mockResolvedValueOnce(
        response(503, { error: "PROFILE_UPLOAD_UNAVAILABLE" }),
      );
    await renderProvider();

    await act(async () => {
      await current().uploadProfilePhoto(
        new Blob(["image"], { type: "image/jpeg" }),
        SUBJECT_A,
      );
    });

    expect(current().uploadState).toBe("error");
    expect(mocks.toast).toHaveBeenCalledWith(
      "Photo upload failed",
      "error",
      "Profile",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
