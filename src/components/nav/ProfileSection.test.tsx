// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROFILE_FIELD_LENGTH,
  ShellProfileContext,
  type ShellProfileContextValue,
} from "@/components/layout/ShellProfileContext";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  fetch: vi.fn(),
  profileName: vi.fn(),
  schedule: vi.fn(),
  retry: vi.fn(),
  crop: vi.fn(),
}));

vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("react-easy-crop", () => ({
  default: ({
    onCropComplete,
  }: {
    onCropComplete: (area: unknown, areaPixels: unknown) => void;
  }) => (
    <button
      id="complete-crop"
      onClick={() =>
        onCropComplete(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 0, y: 0, width: 10, height: 10 },
        )
      }
    >
      Complete crop
    </button>
  ),
}));
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
vi.mock("./cropImage", () => ({
  getCroppedImageBlob: mocks.crop,
}));

import { ProfileSection } from "./ProfileSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const profile = {
  display_name: "Name",
  role_title: "Role",
  bio: null,
  avatar_url: null,
  email: "account@example.test",
};

function contextValue(
  overrides: Partial<ShellProfileContextValue> = {},
): ShellProfileContextValue {
  return {
    state: "ready",
    profile,
    draft: {
      name: "Name",
      role: "Role",
      bio: "",
      photo: "",
    },
    saveState: "idle",
    hasPendingChanges: false,
    scheduleProfileSave: mocks.schedule,
    retryProfileSave: mocks.retry,
    ...overrides,
  };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let container: HTMLDivElement;
let root: Root | null;

async function renderProfile(value = contextValue()) {
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
}

function setInput(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`Missing input ${selector}`);
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:avatar"),
    revokeObjectURL: vi.fn(),
  });
  mocks.crop.mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
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

describe("ProfileSection", () => {
  it("renders root-owned draft state and delegates a full bounded edit", async () => {
    await renderProfile();

    const name = setInput("#profile-name", "Saved Name");

    expect(name.maxLength).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(
      container.querySelector<HTMLInputElement>("#profile-role")?.maxLength,
    ).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(
      container.querySelector<HTMLTextAreaElement>("#profile-bio")?.maxLength,
    ).toBe(MAX_PROFILE_FIELD_LENGTH);
    expect(mocks.schedule).toHaveBeenCalledWith({
      name: "Saved Name",
      role: "Role",
      bio: "",
      photo: "",
    });
    expect(mocks.profileName).toHaveBeenCalledWith("Name");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses honest retained-change copy and exposes an explicit retry", async () => {
    await renderProfile(
      contextValue({
        saveState: "error",
        hasPendingChanges: true,
      }),
    );

    expect(container.textContent).toContain("Save failed — changes kept");
    expect(container.textContent).not.toContain("Retry pending");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry save",
    );
    act(() => retry?.click());
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("keeps session-expired feedback actionable", async () => {
    await renderProfile(
      contextValue({
        state: "signed-out",
        saveState: "session-expired",
        hasPendingChanges: true,
      }),
    );

    expect(container.textContent).toContain(
      "Session expired — changes not saved",
    );
    expect(
      container.querySelector<HTMLAnchorElement>('a[href="/login"]'),
    ).not.toBeNull();
  });

  it("hands a completed avatar upload to the persistent owner after consumer unmount", async () => {
    let resolveUpload!: (value: unknown) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
    );
    await renderProfile();

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Missing avatar file input");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["image"], "avatar.jpg", { type: "image/jpeg" })],
    });
    act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    act(() =>
      container.querySelector<HTMLButtonElement>("#complete-crop")?.click(),
    );
    const savePhoto = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save Photo",
    );
    act(() => savePhoto?.click());
    await act(flush);
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/profile/avatar",
      expect.objectContaining({ method: "POST" }),
    );

    act(() => root?.render(<div>Different route</div>));
    resolveUpload({
      status: 200,
      ok: true,
      json: vi.fn().mockResolvedValue({ url: "https://cdn.test/avatar.jpg" }),
    });
    await act(flush);

    expect(mocks.schedule).toHaveBeenCalledWith({
      name: "Name",
      role: "Role",
      bio: "",
      photo: "https://cdn.test/avatar.jpg",
    });
  });
});
